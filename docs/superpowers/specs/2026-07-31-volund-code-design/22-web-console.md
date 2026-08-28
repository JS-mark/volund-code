# §22 Volund Web Console（本地 Web 控制台）

> **状态**：PROPOSED / NOT SHIPPED
>
> **日期**：2026-08-28
>
> **产品名**：`Volund Web`；命令入口为 `volund web`
>
> **参考对象**：CodeBuddy 内置 Web 服务的交互与信息架构。本文只借鉴产品能力，不复制其实现、协议或品牌。
>
> **实施计划**：[2026-08-28-volund-web-console.md](../../plans/2026-08-28-volund-web-console.md)

## 22.1 结论与范围

Volund Web 是 Volund CLI 的**本地浏览器界面**，不是第二套 Agent 内核，也不是独立 IDE。首个可交付版本只监听 loopback，由本机 `volund` 进程持有工作区、凭据、会话、权限、工具和扩展运行时；浏览器只负责展示、输入和明确的用户决策。

首个版本必须提供：

1. 会话创建、恢复、流式对话、停止和错误恢复。
2. 模型/Provider、工作目录、附件、上下文和使用量的可见控制。
3. 工具调用、权限审批、文件变更、后台 Shell 和撤销的统一活动流。
4. Memory、Skill、MCP、Plugin、状态、配置和本地遥测的管理界面。
5. 与 Ink TUI 共用同一 application runtime、端口和 CoreEvent 契约。
6. 浏览器侧无凭据、无直接文件系统访问、无任意命令执行能力。

以下能力明确不进入首个版本：

- 公网监听、远程访问、手机控制、微信/企业微信、团队空间、托管服务。
- VS Code 级完整编辑器、任意插件注入 DOM、浏览器直接启动 OS 进程。
- 多用户认证、RBAC、云同步、协作编辑、共享会话链接。
- 在网页中绕过 Volund PermissionManager、Sandbox、workspace trust 或 Plugin Kernel。

## 22.2 CodeBuddy 功能盘点与 Volund 处置

下表是参考站点可见能力的完整分类，也是 Volund 的取舍记录。`Now` 表示本地 Web 主线；`Later` 表示主线稳定后；`Long-term` 表示远程/团队阶段；`No` 表示不做或由外部工具承担。

| 参考能力 | 观察到的功能 | Volund 处置 | 说明 |
|---|---|---|---|
| 全局壳层 | 左侧导航、当前工作区、全局创建入口、账户/帮助菜单 | Now | 改为 workspace switcher、command palette、文档/快捷键入口；不做云账户 |
| Agent 对话 | 新会话、流式输出、停止、模型选择、权限模式、最近会话 | Now | 复用 Runner/EventBus/SessionStore/PermissionManager |
| 输入区 | 多行输入、附件、目录、模式、模型、发送 | Now | 支持文本、文件引用、图片附件、`@` picker；附件只传本地引用 |
| 多 Agent | Agent 列表、群组、频道、上下文继承 | Later | 首版只展示 subagent lineage；不制造独立“群聊”抽象 |
| 定时任务 | cron 任务、模板、执行记录 | Later | 本地 deterministic automation；默认关闭，另立安全规范 |
| 终端画布 | 多终端、复制、缩放、独立窗口 | Later | 首版只管理由工具启动的后台 shell；不提供任意裸终端 |
| 编辑器 | 文件树、搜索、Git、编辑器、集成终端 | Partial/No | 首版提供变更 diff、引用文件、打开外部编辑器；不重做 IDE |
| 插件 | 已安装、市场、来源、分类、启停、卸载 | Now/Conditional | 管理已由 Volund 端口支持的 Plugin/Skill/MCP；市场安装受 Plugin Kernel/Catalog 硬门约束 |
| 远程控制 | 微信、企业微信、远程实例 | Long-term | 必须等本地模型、安全审计、认证与撤销协议成熟后单独立项 |
| 设置 | 模型端点、推理、权限、压缩、checkpoint、Memory、语言、环境、沙箱 | Now | 只显示 schema 允许的字段；敏感值只显示“已配置/未配置” |
| 可观测性 | worker、统计、trace、metrics、logs | Now/Later | 首版提供本地事件、用量、工具时延、健康和脱敏日志；完整 trace explorer 后置 |
| 实例管理 | 实例列表、运行状态 | Long-term | 本地仅显示当前 server/process；多机器实例属于远程控制 |
| 帮助 | 文档、快捷键、更新日志 | Now | 链接官方文档站和本地 shortcut overlay |

## 22.3 产品原则

### 22.3.1 一个内核，两个界面

Ink TUI 与 Web 只能是同一 application runtime 的两个 adapter：

```text
                       ┌─ Ink UI adapter
CLI command ─ app-runtime ─┤
                       └─ Web server adapter ─ browser UI

app-runtime ─ Runner / EventBus / SessionStore / PermissionManager
            ─ Provider / Router / ToolRegistry / MCP / Skill / Plugin
            ─ Memory / Telemetry / Trust / Config / Native Bridge
```

不得把 `apps/cli/src/runtime.ts` 整文件复制到 Web，也不得让 Web 依赖 Ink 组件。先抽取界面无关的 composition root、session controller 和管理端口，再接两个界面。

### 22.3.2 Server authoritative

- session、turn、permission、tool、config 和扩展状态均以本机 server 为准。
- 浏览器 optimistic update 只可用于输入草稿、折叠状态、路由和非权威 UI 偏好。
- 所有写操作带 request id；重复请求必须幂等或返回已完成结果。
- 页面刷新后通过 snapshot + event cursor 恢复，不依赖浏览器缓存推断运行状态。

### 22.3.3 本地优先与最小暴露

- 默认 `127.0.0.1`，不得默认监听 `0.0.0.0`、LAN 或 Unix socket 转发器。
- 默认自动打开一次浏览器；终端持续显示 URL、PID、cwd、停止方式和安全状态。
- 不在 URL、localStorage、日志或事件里放 API key、OAuth token、MCP header 或完整敏感 tool input。
- 关闭 server 后，临时 browser session 和未完成授权全部失效。

### 22.3.4 诚实的实现状态

网页只能展示运行时真实支持的能力。`implemented-unwired`、平台不可用、Provider 不上报、Plugin Kernel 尚关闭等状态必须显示 `unavailable`/`not configured`，不得用空列表或 0 伪装成功。

## 22.4 用户与核心旅程

### 22.4.1 主要用户

- **本地开发者**：希望保留 Volund 安全模型，同时获得更强的信息密度和可视化。
- **维护者/插件作者**：需要查看运行状态、插件/Skill/MCP、事件和诊断。
- **自动化用户**：在本机浏览器观察长任务，但不因此获得额外权限。

### 22.4.2 首次启动

1. 用户执行 `volund web --cwd <path>`。
2. CLI 归一化 cwd，执行与 `volund` 相同的 path guard 和 workspace trust。
3. 未信任目录先在终端或浏览器完成 trust gate；信任前不得读取项目配置、MCP 或插件。
4. server 绑定 loopback 随机端口，生成内存态启动 nonce 和 browser session。
5. 浏览器打开 `/onboarding`，展示工作区、沙箱 tier、Provider、关键风险和缺失依赖。
6. 用户选择模型并创建首个 session；失败时保留诊断入口。

### 22.4.3 日常对话

1. 在 session 列表新建或恢复会话。
2. 输入 prompt，添加本地文件/图片引用，选择单轮模型覆盖。
3. 页面按 CoreEvent 顺序渲染 stream、tool、permission、usage 和 error。
4. 权限请求进入全局审批队列；用户可以 allow once/session/project/forever 或 deny。
5. turn 结束后展示用量、文件变更、可撤销点和后续建议。
6. 刷新/断线后从持久化 snapshot 和 cursor 继续，不重复提交 turn。

### 22.4.4 长任务观察

1. 用户切换到其他 session 或关闭标签页，server 中的任务继续按原策略运行。
2. 未决 permission 不自动通过；超时后 deny 或保持待决，以 PermissionManager 策略为准。
3. 重开网页可查看后台 shell、subagent、tool activity、错误和用量。
4. 终止 session 必须同时 interrupt Runner、结束后台 shell、flush storage 并发出 `session.ended`。

## 22.5 信息架构与路由

### 22.5.1 全局壳层

```text
┌ Workspace / Volund Web ───────────── Search / Command Palette / Health ┐
│ Sessions                                                                 │
│   Recent sessions            ┌ Main route ───────────────────────────┐   │
│   New session                │                                       │   │
│ Runtime                     │                                       │   │
│   Activity / Shells          │                                       │   │
│ Knowledge                   │                                       │   │
│   Memory / Skills / MCP      │                                       │   │
│ Extensions                  │                                       │   │
│   Plugins                    │                                       │   │
│ Observe                     │                                       │   │
│   Status / Telemetry / Logs  └───────────────────────────────────────┘   │
│ Settings                                                                  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 22.5.2 路由表

| Route | 功能 | 写能力 |
|---|---|---|
| `/onboarding` | 首次运行、trust、Provider 和 sandbox disclosure | trust/config 的受控写 |
| `/sessions` | 最近会话、搜索、筛选、新建、恢复、结束 | 新建/结束 |
| `/sessions/:id` | 对话、stream、composer、tool/permission activity | submit/interrupt/decision |
| `/sessions/:id/changes` | 本会话文件变更、diff、backup、undo | 受控 undo |
| `/activity` | 全局运行中 session、subagent、tool、permission 队列 | interrupt/decision |
| `/shells` | 由 Volund 工具启动的后台 shell、尾部输出、kill | kill only |
| `/memory` | list/search/show/add/edit/delete/pin/import/export | 经 MemoryPort |
| `/skills` | 多 scope 列表、详情、安装、启停、会话激活 | 经 SkillPort |
| `/mcp` | server 状态、工具清单、测试、添加、删除、启停、认证状态 | 经 McpPort |
| `/plugins` | builtin/dev/market inventory、详情、doctor、启停 | 受 Plugin Kernel 状态限制 |
| `/status` | session/runtime/native/provider/cache/context 快照 | 只读 |
| `/telemetry` | 本地 usage、cost、tool latency、deny/allow、health | clear/export 需确认 |
| `/logs` | 脱敏结构化日志、过滤、下载诊断包 | 下载/清理需确认 |
| `/settings` | schema 驱动配置、权限、Provider、上下文、UI 偏好 | 分 scope 受控写 |
| `/review` | §17 本地 code review 的配置、运行、finding 浏览 | 只读代码；可启动 review |

窄屏时侧栏变为 drawer；首版保证桌面和平板可用，不承诺手机远程控制体验。

## 22.6 功能规格

### W-01 启动、停止与单实例

- `volund web` 启动本地 server；默认随机空闲端口，`--port` 仅接受 `1024..65535`。
- `--host` 首版只接受 `127.0.0.1` 或 `::1`；任何其他值直接拒绝并指向长期远程规范。
- 默认按 `(canonical cwd, user)` 复用健康实例；`--new-instance` 可显式启动第二实例。
- 终端收到 SIGINT/SIGTERM 后停止接收新请求、interrupt 活跃 turn、等待有界 flush、结束 shell、关闭 server。
- browser health 页面显示 server id、版本、PID、启动时间、cwd、native tier 和持久化健康。

**验收**：端口冲突有明确错误；重复启动可发现实例；异常退出重启后能恢复已持久化 session，不能恢复的临时状态诚实标记。

### W-02 Workspace、Trust 与 Onboarding

- workspace switcher 只列显式打开过且仍存在的路径，不递归扫描 home。
- 所有路径经 `realpath`、敏感目录和 symlink escape 检查；规则与 §11.6 相同。
- trust decision 支持 exact/tree；项目 config hash 变化重新确认。
- onboarding 显示 Provider 认证状态、sandbox tier、native worker、默认模型和 project config 来源。
- 未 trust 前不得加载 `.volund/config.toml`、`mcp.toml`、项目 Skill/Plugin 或项目 prompt。

**验收**：恶意项目配置在 trust 前零读取/零执行；撤销 trust 后新 session 不再加载项目能力。

### W-03 Session 列表与生命周期

- 列表字段：title/首条 prompt、session id、cwd、模型、更新时间、turn 数、状态、tags、父 session。
- 支持分页、项目过滤、文本搜索、运行中/等待权限/失败/完成筛选。
- 新建、恢复、命名、结束、导出；删除/clear 后置且必须二次确认和可审计。
- 同一 session 同一时刻只允许一个 in-flight turn；多标签提交冲突返回 `409 turn_in_progress`。
- session 页面顶部始终显示 cwd、模型、context、sandbox/permission mode 和连接状态。

**验收**：多标签不重复 turn；恢复后消息、tool result 和 usage 顺序稳定；未知新版本 JSONL fail closed。

### W-04 Chat、Streaming 与消息渲染

- 支持 user/assistant/system/tool 消息、thinking（若 Provider 允许展示）、Markdown、代码块、引用和错误卡片。
- `stream.delta` 只在内存传输；`stream.completed` 后以持久化完整消息为准。
- 渲染按 `(sessionId, turnId, event.id)` 去重；乱序 cursor 触发 resync，不自行重排业务事件。
- Stop 按钮调用 Runner interrupt；停止后显示明确的 aborted 状态和已完成工具副作用。
- Markdown 禁止任意 HTML/script、`javascript:` URL、未授权本地文件 URL 和自动加载远程图片。

**验收**：高速 delta 不阻塞 server；刷新后不丢完整消息；恶意模型输出无法执行脚本或读取本地资源。

### W-05 Composer、附件与上下文引用

- 多行编辑、发送快捷键、草稿自动保存、历史输入、slash command 和统一 `@` picker。
- 文件候选遵守 gitignore、workspace root 和敏感路径规则；支持 `@@path` 显式文件模式、`@!alias` 模型模式。
- 图片/文件通过 server 创建 attachment reference；二进制不进 EventBus、JSONL、日志或 localStorage。
- `#sess_<id>` 跨会话引用遵守 §8.5 权限、budget 和注入包装。
- 粘贴绝对路径只展示归一化后的 workspace-relative label；发送前显示实际引用数与总大小。

**验收**：超大小/类型/数量有确定错误；附件删除和缺失可恢复；路径不能越出 workspace 或进入敏感目录。

### W-06 Provider、模型、Router 与运行模式

- 显示已装 Provider、认证状态、模型、alias、capability、context window、vision/cache 支持和健康。
- 可设置全局默认、项目默认、session 默认和单 turn 覆盖；来源链必须可见。
- Router 只展示 runtime 实际装配的 Single/Role/Fallback 等策略；未接线策略显示 unavailable。
- 推理强度、temperature、cache 等只在 Provider capability 与 config schema 同时允许时出现。
- “规划/执行”等模式若未来加入，必须映射为真实 prompt/tool policy，不得只是 UI 标签。

**验收**：不支持字段不会提交；切模型不改变已有消息；Provider 错误包含可操作诊断且不暴露凭据。

### W-07 Permission、Sandbox 与审批队列

- 所有权限请求由真实 PermissionManager 创建；Web 不从 tool input 自行推导 PermissionSpec。
- 卡片展示 tool、经过 SafeDisplay/脱敏的目标、风险、sandbox tier、来源 session/subagent、scope 选项。
- 决策：allow once/session/project/forever、deny、deny forever；不适用的 scope 不渲染。
- 多请求全局串行或按既有 manager 队列规则处理；MCP fatigue 合并和限速遵守 §11.3.9。
- 标签页关闭、断线或 session 结束不能隐式 allow；stale decision 返回 `409 permission_resolved`。
- dangerous skip 状态用持续红色 banner，不能仅启动时 toast。

**验收**：伪造 request id、跨 session decision、重复 decision、已过期 decision 全拒绝；server 断线不扩大权限。

### W-08 Tool Activity、变更、Diff 与 Undo

- activity 卡按 requested → permission → started → completed/error 展示 tool 生命周期和耗时。
- Read/Grep/Glob 仅展示摘要；Write/Edit/MultiEdit 展示受控 diff、lines added/removed 和 backup 状态。
- Bash 显示命令的 SafeDisplay、cwd、exit code、截断状态和输出摘要；完整输出按需读取且有大小上限。
- `/changes` 只基于 Volund 记录的 tool effect/backup，不把所有 working tree 修改归因给当前 session。
- Undo 遵守 §8.6.2 选点和并发保护；先 preview，再确认执行。

**验收**：用户预先存在的 dirty changes 不被误归因或覆盖；大 diff 虚拟化；undo 冲突 fail closed。

### W-09 Background Shell

- 只展示由 Volund Bash tool 创建的 background shell；首版不提供任意 terminal emulator 输入。
- 字段：shell id、session、command SafeDisplay、cwd、start time、状态、exit code、dropped bytes。
- 支持有界 tail、暂停自动滚动、下载脱敏输出和 kill。
- session end 默认 kill；若未来支持 detached shell，必须另立所有权和恢复规范。

**验收**：kill 幂等；输出 ring buffer 有明确截断；控制字符不会污染页面。

### W-10 Subagent 与并发工作

- 首版展示 parent/child session/turn lineage、agentType、预算、状态、当前 tool 和结果摘要。
- 不创建 CodeBuddy 式持久群组/频道模型；Volund 的权威语义仍是 §2.7 subagent。
- 可从 parent activity interrupt child；权限请求明确标出 child 来源但由相同安全策略决策。
- event 冒泡保留原 `event.id` 和 parent tags，Web 去重不能重新生成 id。

**验收**：child 事件不会双显；预算耗尽/取消可追溯；parent 结束能清理 child。

### W-11 Memory

- 支持 list/search/show/add/edit/remove/pin/unpin/import/export 和 scope 过滤。
- 每条展示 scope、来源、更新时间、pin、recall 次数和敏感性标签；正文按需加载。
- 项目/会话 Memory 操作继续走原 ACL、permission 和 preWrite hook；Web 无后门。
- 模型 recall 与人工管理分开记录，不把“显示过”算作 recall。

**验收**：跨 workspace/用户读取被拒绝；导出脱敏；删除/导入有明确确认和错误恢复。

### W-12 Skills、MCP、Plugins 与 Hooks

- `/skills`：多 scope inventory、详情、安装、卸载、启停、session activate/deactivate、validate/重扫。
- `/mcp`：server inventory、transport/认证状态、tools/resources、test、inspect、add/remove、enable/disable/reload。
- `/plugins`：builtin/dev/market 三来源 inventory、compatibility、permissions、doctor、enable/disable/uninstall。
- Plugin Kernel/Catalog 关闭时，网页只能显示 `contained/unavailable` 和 doctor 结果；不得从 Web 重开 legacy activation。
- MCP secret 只通过 keyref/auth 流；网页永不回显 Authorization、env secret 或 URL userinfo。
- Hooks 首版只读 list/show/test dry-run；启停仍通过插件/config 的权威路径。
- 插件 UI contribution 只能使用经过 schema 校验的声明式 section/table/row；禁止第三方 JS/HTML 注入 Web DOM。

**验收**：CLI/TUI/Web 对同一 inventory 和 enabled 状态一致；不可信 manifest/输出被拒绝；安装过程可诊断且不越过供应链硬门。

### W-13 Settings 与 Config

- 页面由 `APPENDIX-C-config-schema`/运行时 schema 生成，展示 key、类型、默认值、有效值、来源和是否允许 project override。
- 支持 global/project scope；project 写入需 trust，forbidden key 不出现 project 编辑器。
- secret 字段只允许 set/replace/clear，读取永远返回 presence metadata。
- 保存前做 schema validation、影响预览和 restart-required 标记；写文件使用原子更新与冲突检测。
- UI 偏好（theme、density、sidebar）与 runtime config 分离，前者可浏览器本地保存。

**验收**：未知 key、类型错误、并发覆盖、项目越权和 secret 回显均被拒绝；失败不留下半写配置。

### W-14 Status、Usage、Telemetry 与 Logs

- `/status` 复用 §11.3.14 view model：session、context、usage/cost、cache、tools/permissions、plugins/skills、Memory、native/runtime health。
- `/telemetry` 读取本地 TelemetryStore，按时间、Provider、模型、tool、allow/deny、sandbox tier 聚合。
- `/logs` 只展示结构化、脱敏、大小有界的本地日志；支持 level/component/session/request id 过滤。
- 未知 usage/pricing/cache 字段保持 unknown/n/a，不填 0。
- export diagnostic bundle 默认列出文件清单和脱敏规则，用户确认后生成；绝不自动上传。

**验收**：默认无网络上报；敏感 corpus 扫描通过；大日志分页；clear/export 有审计记录。

### W-15 Code Review

- Web 提供 §17 的 working-tree/staged/base/range/PR 参数表单、运行进度和 finding 浏览。
- finding 按 severity/category/file 分组，定位可打开外部编辑器或复制 path:line。
- Review pipeline 仍是只读工具白名单、untrusted wrapping 和 typed output；Web 只调用端口。
- Web 不提供“一键应用全部 finding”；后续若支持修复，必须作为新的有权限 Agent turn。

**验收**：与 `volund review --json` schema 一致；PR/代码中的注入不能改变页面或工具策略。

### W-16 Command Palette、快捷键、可访问性与语言

- `Cmd/Ctrl+K` 全局命令；`Cmd/Ctrl+Enter` 发送；`Esc` 先关闭 modal，再 interrupt 的危险动作需二次明确。
- 所有关键操作可键盘完成；焦点可见，modal focus trap，screen reader 有状态文本。
- 颜色不是唯一状态信号；默认满足 WCAG 2.2 AA 对比度，支持 reduced motion。
- 首版文案键值化，交付中英文；错误码与机器字段不翻译。

**验收**：axe/Playwright keyboard suite 无 blocker；中英文切换不重启 session；窄屏无关键操作丢失。

### W-17 本地定时任务（Later）

- 目标是对受控任务模板执行 `volund` 非交互入口，并记录 schedule、输入、权限策略、结果和重试。
- 默认关闭；不允许把 `--dangerously-skip-permissions` 存进任务模板。
- 任务创建时冻结 cwd、模型、最大预算、允许工具、网络域和超时；执行时重新检查 trust/config hash。
- 该能力需单独 threat model、持久 scheduler 所有权和休眠/重启语义，不能附带进首版。

### W-18 远程、团队与消息平台（Long-term）

远程连接、手机控制、微信/企业微信、多实例和团队协作统一进入长期路线，至少满足以下硬门后才可设计实现：

1. 本地 Web 达到 `verified-local`，安全与隐私测试完整。
2. 独立认证、设备绑定、会话撤销、短期 token、重放保护和 CSRF/Origin 模型冻结。
3. 端到端加密或明确的 transport trust、审计日志、rate limit 和 abuse 防护。
4. 远程发起 tool/permission 的身份与本机用户在 UI 中不可混淆。
5. 默认不暴露公网；tunnel/relay 必须显式 opt-in，支持立即撤销。
6. 微信/企业微信只做消息 adapter，不直接拥有工具、文件或 permission authority。

远程功能不得通过简单开放 `--host 0.0.0.0`、关闭 Origin 检查或复用启动 nonce 实现。

## 22.7 架构与包边界

### 22.7.1 新增结构

```text
apps/
├─ cli/                         # `volund web` 命令、terminal lifecycle
└─ web/                         # React DOM browser app；静态资源，不接触 Node API

packages/
├─ app-runtime/                 # UI-neutral composition root、session/controllers/ports
├─ web-server/                  # loopback HTTP、SSE、auth/origin、static assets
├─ ui-model/                    # 可选：TUI/Web 共用 view model、formatter、sanitizer
├─ ui/                          # Ink adapter，只依赖 app-runtime/ui-model 的契约
└─ existing runtime packages  # core/storage/permission/plugin/telemetry 等保持原边界
```

`app-runtime` 是必须先完成的边界重构。它接收 filesystem/network/clock/browser-open 等 host ports，构造 Runner、EventBus、SessionStore、PermissionManager、Router、tools、extensions 和 telemetry，并暴露：

- `SessionController`
- `PermissionController`
- `WorkspaceController`
- `ConfigController`
- `MemoryController`
- `SkillController`
- `McpController`
- `PluginController`
- `StatusController`
- `TelemetryController`
- `ReviewController`

### 22.7.2 依赖规则

| 包 | 允许依赖 | 禁止 |
|---|---|---|
| `apps/web` | generated API types、browser UI libs | Node builtin、provider、tool、storage、native |
| `web-server` | app-runtime、core type、shared、storage type | Ink、Provider 实现细节、直接 secret store API |
| `app-runtime` | 现有 runtime packages | React/Ink/HTTP transport |
| `ui-model` | shared、core/permission type-only | Node I/O、React DOM/Ink |
| `ui` | app-runtime/ui-model contracts | 重新装配 Provider/Tool/Storage |

CI 增加 import-boundary 检查；浏览器 bundle 扫描不得包含 Node polyfill、credential 字段或 server-only package。

### 22.7.3 Server 组件

```text
LoopbackListener
├─ BrowserSessionGuard    # nonce exchange、HttpOnly cookie、Origin/Host/CSRF
├─ ApiRouter              # typed commands + schema validation
├─ EventStreamGateway     # CoreEvent/view-event SSE、cursor、backpressure
├─ SnapshotService        # sessions/status/controllers 的权威快照
├─ StaticAssetServer      # CSP + immutable hashed assets
└─ ShutdownCoordinator    # drain/interrupt/flush/kill
```

首版选择 **HTTP commands + SSE events**，不选 WebSocket：当前交互主要是 server→browser 事件流，command 是离散请求；SSE 更容易重连、代理和审计。若以后出现高频双向 terminal protocol，再为该单一能力评估 WebSocket，不能替换所有命令面。

## 22.8 API 契约

### 22.8.1 公共约定

- base path：`/api/v1`。
- JSON request/response 均由共享 schema 生成；未知字段默认拒绝。
- 成功：`{ data, requestId }`；失败：`{ error: { code, message, retryable, details? }, requestId }`。
- mutation 支持 `Idempotency-Key`；涉及当前状态时带 `If-Match`/revision。
- secret read API 只返回 `{ configured: boolean, source?: string }`。
- path 输出默认 workspace-relative display path；绝对路径仅在明确诊断字段返回并受脱敏策略控制。

### 22.8.2 Endpoint 清单

| Method | Endpoint | 用途 |
|---|---|---|
| `POST` | `/browser-session/exchange` | 一次性启动 nonce 换 HttpOnly browser session |
| `GET` | `/health` | server/version/runtime health |
| `GET` | `/bootstrap` | workspace、capabilities、current user-safe settings |
| `GET` | `/events?cursor=` | SSE event stream |
| `GET/POST` | `/sessions` | list/create |
| `GET/PATCH` | `/sessions/:id` | snapshot/rename |
| `POST` | `/sessions/:id/resume` | 恢复为 active runtime |
| `POST` | `/sessions/:id/turns` | 提交 prompt/attachments/overrides |
| `POST` | `/sessions/:id/interrupt` | 停止当前 turn |
| `POST` | `/sessions/:id/end` | 结束 session |
| `GET` | `/sessions/:id/changes` | effect/diff/backup snapshot |
| `POST` | `/sessions/:id/undo/preview` | 生成可撤销预览 |
| `POST` | `/sessions/:id/undo` | 带 preview revision 执行 |
| `GET/POST` | `/permissions` | list pending / 提交 decision |
| `GET/POST` | `/attachments` | metadata/list / 创建引用式附件 |
| `GET/POST` | `/shells` | list / kill action |
| `GET/POST` | `/memory/actions` | query + typed action |
| `GET/POST` | `/skills/actions` | inventory + typed action |
| `GET/POST` | `/mcp/actions` | inventory + typed action |
| `GET/POST` | `/plugins/actions` | inventory + typed action |
| `GET/PATCH` | `/config` | effective config / scoped mutation |
| `GET` | `/status` | §11.3.14 view model |
| `GET/POST` | `/telemetry` | query / export-clear action |
| `GET` | `/logs` | bounded filtered logs |
| `POST` | `/reviews` | 启动 §17 review |
| `GET` | `/reviews/:id` | report/progress |

管理类 endpoint 使用 tagged union action，例如 `{ action: "setEnabled", name, enabled }`；不得接受任意方法名、模块名、shell 命令或文件路径拼接调用。

### 22.8.3 Event stream

CoreEvent 不改名、不改 payload。Web transport 只加外层 envelope：

```ts
interface WebEventEnvelope {
  streamVersion: 1
  cursor: string
  kind: 'core' | 'view' | 'control'
  sessionId?: string
  event: CoreEvent | ViewEvent | ControlEvent
}
```

- `kind=core`：§2.3/附录 D 的稳定事件，payload 必须先通过既有 schema。
- `kind=view`：只用于 permission queue、health、inventory changed 等界面投影；有独立 schema，不能伪装 CoreEvent 或落入 session JSONL。
- `kind=control`：`hello`、`resync_required`、`server_draining`、`heartbeat`。
- 每连接有 bounded queue；落后超阈值发送 `resync_required` 并断开，禁止无界缓存拖垮 Runner。
- reconnect 用 cursor；cursor 过旧则拉 snapshot 后从新 cursor 开始。

## 22.9 状态、持久化与并发

### 22.9.1 权威状态

| 状态 | 存储位置 | 浏览器策略 |
|---|---|---|
| session messages/tools | `~/.volund/sessions/*.jsonl` | snapshot + SSE |
| stream delta | server 内存 | 断线后由完整 message 恢复 |
| attachment binary | attachment store | 只持有 opaque id/metadata |
| pending permission | PermissionManager 内存 | 重连重取；server 重启后不恢复旧授权 |
| config/trust | 既有 TOML/trust store | revision 写入 |
| Memory/Skill/MCP/Plugin | 既有各自 store | controller inventory |
| telemetry/logs | 本地 append store | 分页查询 |
| UI 偏好/草稿 | browser local storage | 不含 secret/absolute sensitive path |

### 22.9.2 并发规则

- 一个 active session 一个 turn mutex；不同 session 可并行，受全局 provider/tool/sandbox budget 限制。
- config、plugin state、MCP 和 Skill mutation 使用 revision/CAS；冲突返回最新 snapshot。
- permission decision 以 request id + state revision CAS。
- shutdown 期间 mutation 返回 `503 server_draining`，只读 snapshot 可在 drain 窗口继续。

## 22.10 安全与隐私模型

### 22.10.1 浏览器会话

1. 启动 URL 带一次性 fragment nonce（fragment 不发给 HTTP server/log）；bootstrap JS 通过 POST exchange。
2. server 设置 `HttpOnly; SameSite=Strict` cookie；生产模式不把 bearer token 暴露给 JS。
3. mutation 需要 CSRF token + exact Origin/Host 检查。
4. nonce 单次、有界有效期；browser session 绑定 server id，server 重启即失效。
5. CORS 默认完全关闭；不支持第三方 origin iframe。

### 22.10.2 Web 安全头

- 严格 CSP：`default-src 'self'`，脚本/style 使用构建 hash/nonce，不允许 `unsafe-eval`。
- `frame-ancestors 'none'`、`base-uri 'none'`、`form-action 'self'`、`object-src 'none'`。
- `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、禁缓存敏感 API。
- Markdown 链接外跳加确认/标识；远程图片默认不加载。

### 22.10.3 数据最小化

- API key、OAuth/MCP secret、原始 credential env 不进入 API payload。
- tool input/output 先过字段级 SafeDisplay/sanitize；“脱敏后展示”与“运行时真实输入”使用不同类型。
- 日志默认不记录 prompt/文件正文/tool 完整输出；诊断模式有明显 banner、期限和退出自动关闭。
- 任何未来远程能力必须重新做 threat model，不继承“loopback 即可信”的假设。

## 22.11 错误、恢复与版本兼容

### 22.11.1 错误码

Web server 错误加入附录 B registry，至少覆盖：

- `web_origin_rejected`
- `web_session_invalid`
- `web_csrf_invalid`
- `web_schema_invalid`
- `web_cursor_expired`
- `web_backpressure_resync`
- `web_turn_in_progress`
- `web_state_conflict`
- `web_server_draining`
- `web_capability_unavailable`

### 22.11.2 恢复策略

- 网络短断：指数退避重连 SSE，保留草稿，mutation 不自动重发，除非带相同 idempotency key。
- Provider/tool 错误：展示 `error.raised` 与 retryability；重试创建新 turn attempt，不改历史 event。
- server 重启：重新 exchange，读取 session snapshot；旧 pending permission 作废。
- schema/version 不兼容：阻止 mutation，提示升级/刷新；server 保持 CLI/TUI 可用。
- 前端 error boundary 不能吞掉 Agent 运行；提供复制脱敏诊断信息和回到 session 的入口。

## 22.12 性能预算

| 指标 | 目标 |
|---|---|
| loopback server ready | warm < 500 ms；cold < 1.5 s（不含 Provider 探测） |
| first UI usable | warm < 1 s；cold < 2.5 s |
| event display latency | p95 < 100 ms（loopback，非 hidden tab） |
| submit→server accepted | p95 < 100 ms |
| session list first page | 10k sessions 下 < 500 ms，必须走索引/分页 |
| message rendering | 5k message session 可打开，窗口化列表，无全量 DOM |
| SSE client queue | 有界；超阈值 resync，不允许无界内存增长 |
| browser initial JS | gzip 目标 < 350 KiB；重型 diff/chart route-split |

性能测试必须区分 browser rendering、gateway、Runner/provider latency，不能把 Provider 网络耗时归为 Web UI 回归。

## 22.13 测试与证据

### 22.13.1 测试层

1. **Schema/contract**：API、view event、CoreEvent passthrough、错误码、version corpus。
2. **Controller**：app-runtime 的 session/permission/config/extensions/status 端口，无 HTTP/React。
3. **Gateway**：Origin/Host/CSRF/nonce、cookie、idempotency、cursor、backpressure、shutdown。
4. **Browser component**：stream reducer、permission card、composer、diff、settings、inventory。
5. **E2E**：真实本地 server + browser + mock Provider/native fixtures；覆盖 new/resume/interrupt/permission/attachment/undo/reconnect。
6. **Boundary E2E**：至少一个真实 Provider 外部 gate、真实 sandbox、真实 session persistence 和 existing dirty worktree。
7. **Security corpus**：XSS/Markdown、path traversal/symlink、CSRF/DNS rebinding、secret leak、stale/replay decision、oversized payload。
8. **A11y/visual**：键盘、screen reader、contrast、reduced motion、desktop/tablet snapshots。

### 22.13.2 必须记录的 evidence

- exact SHA、OS/arch、Node/browser、命令、exit status。
- composition root 真实接线；不能用 mock controller 证明产品入口。
- CLI/TUI/Web 对相同 session/config/inventory 的一致性测试。
- secret scan、browser bundle dependency scan、安全头快照。
- 10k session/5k message/高频 delta 的性能结果。
- 外部凭据、真实网络、签名/发布继续标 `external-pending`。

## 22.14 分阶段交付

| Track | 内容 | Roadmap 对齐 |
|---|---|---|
| W0 Boundary | 抽 `app-runtime`、controller、view model；TUI 回归不变 | R0/R1 前置重构 |
| W1 Local shell | `volund web`、loopback security、bootstrap、session list | R4 optional slice |
| W2 Core chat | streaming/composer/model/permission/tool/changes/undo | R4 optional slice |
| W3 Management | Memory/Skill/MCP/Plugin/settings/status | 依赖各能力自身达到可接线状态 |
| W4 Observe/review | telemetry/logs/shell/subagent/review/a11y/perf | R4/R5 |
| W5 Local automations | 定时任务、安全 scheduler | R6 独立能力 |
| W6 Remote/team | 远程、手机、微信/企微、多实例/团队 | R6+ 长期，独立 threat model |

Volund CLI 的 R1–R5 不应被 Web 阻塞；Web 是可选产品 slice。但一旦对外宣称 Web 可用，其选定 scope 必须单独达到 `verified-local`/`verified-ci`/`release-ready`，不能用 CLI 的证据代替。

## 22.15 首版 Definition of Done

首版只有同时满足以下条件才可称为 beta：

- `volund web` 是真实 CLI 入口，默认仅 loopback，停止/恢复可验证。
- composition root 已抽取；TUI 与 Web 共用 controller，重复业务实现清单为 0。
- new/resume/stream/interrupt/permission/tool/diff/undo/attachment 全链路 E2E 通过。
- Memory/Skill/MCP/Plugin/settings/status 对未实现能力诚实降级。
- Origin/Host/CSRF/nonce/XSS/path/secret/backpressure 安全 corpus 通过。
- existing dirty worktree E2E 证明不会覆盖未归属修改。
- 10k session、5k message、高频 stream 性能预算通过。
- desktop/tablet、键盘和 screen reader 验收通过。
- 文档站包含安装、启动、安全模型、故障排查和远程功能未支持声明。
- same-SHA CI、变更说明、依赖许可、发布资产和独立 review 齐全。

## 22.16 明确决策（避免实现期自定）

| 问题 | 决策 |
|---|---|
| 产品名/命令 | `Volund Web` / `volund web` |
| 首版网络范围 | loopback only；不支持 LAN/public |
| transport | HTTP JSON commands + SSE events |
| runtime | 复用 `app-runtime`；禁止复制 CLI runtime |
| browser 权限 | 无 filesystem/process/credential authority |
| editor | diff + file reference + open external editor；不做完整 IDE |
| terminal | background shell observer/kill；不做任意 terminal emulator |
| multi-agent | 展示 subagent lineage；持久群组/频道后置 |
| plugin UI | 声明式 schema；禁止第三方 JS/HTML |
| remote/微信/企微 | 长期独立项目，不进入本地版本 |
| default telemetry | 本地；不自动上传 |
| authentication | 一次性启动 nonce → HttpOnly local browser session |

> ↩ [返回索引](./README.md) · ← [上一章：§21 动态反思](./21-dynamic-reflection.md)
