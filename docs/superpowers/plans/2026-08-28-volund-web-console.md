# Volund Web Console 实施计划（2026-08-28）

> **状态**：PROPOSED / NOT STARTED
>
> **权威功能规范**：[§22 Volund Web Console](../specs/2026-07-31-volund-code-design/22-web-console.md)
>
> **执行原则**：先拆 composition root，再做 Web；每 phase 通过 evidence gate 后才进入下一 phase。本文不是已实现声明。

## 0. 目标与交付边界

本计划把 CodeBuddy 内置 Web 服务中适合 Volund 的能力，落成一个本地优先、复用现有 Agent 内核的 Web 控制台。首版交付 `volund web`，覆盖 session/chat/permission/tool/changes/extensions/settings/observability；不交付公网、远程手机、微信/企业微信、团队协作、完整 IDE 或任意终端。

最终代码形态：

```text
apps/cli ──┐
           ├─ packages/app-runtime ─ existing core/runtime packages
apps/web ─ web-server ──────────────┘
```

成功标准不是“页面能打开”，而是：同一真实 runtime 同时支撑 CLI/TUI/Web，安全边界不弱化，session 持久化和权限语义一致，并有 same-SHA browser E2E 与安全证据。

## 1. 当前基线与约束

### 1.1 可复用现状

| 现有能力 | 代码/规范 | Web 用法 |
|---|---|---|
| Runner/EventBus/SessionState | `packages/core`，§2、附录 D | session/turn/stream/tool 的权威状态与事件 |
| SessionStore/Attachment/Backup/Memory | `packages/storage`，§8 | resume、附件引用、undo、Memory |
| PermissionManager | `packages/permission`，§4 | 审批队列和 scope 决策 |
| Router/Provider | `packages/router`、`provider-*`，§3 | 模型能力、切换、usage |
| tools/background shell | `packages/tools`，§4 | activity、diff、shell observer/kill |
| Skill/MCP/Plugin | 对应 runtime + CLI ports，§6/§19/专题 | 管理面板；按真实可用状态降级 |
| TelemetryStore | `packages/telemetry`，§8.7 | 本地 usage/health/日志投影 |
| Ink UI | `packages/ui`，§7 | 交互语义参考；不能直接复用 Ink 组件 |
| CLI composition | `apps/cli/src/runtime.ts` | 必须抽取，禁止复制 |

### 1.2 当前风险

1. `apps/cli/src/runtime.ts` 同时包含 composition、host I/O、CLI 管理端口和 UI adapter，Web 若直接调用会形成第二个巨型入口。
2. `ApolloPorts`/部分 controller 类型仍位于 `apps/cli` 或 `packages/ui`，界面无关契约归属不正确。
3. 现有能力状态混合 `verified-local`、`partial`、`implemented-unwired`；Web 不能把后两者包装成可用。
4. CoreEvent 适合 runtime 事实，但 permission queue、inventory changed、health 等需要独立 view-event 契约。
5. loopback 仍受恶意网页的 CSRF/DNS rebinding、XSS、nonce 泄漏和 Host/Origin 欺骗威胁。
6. 当前工作树可能已有用户修改；实现过程必须按 ownership 分阶段提交，不覆盖无关 dirty files。

### 1.3 不可违反的门禁

- 不在 Web 中复制 Provider/Tool/Permission/Plugin/Memory 业务逻辑。
- 不通过监听 `0.0.0.0` 偷渡远程能力。
- 不允许浏览器获得 secret、绝对敏感路径、原始危险 tool input 或 Node API。
- Plugin Kernel/Catalog 未开放前，不从 Web 开启 legacy plugin activation。
- 每 phase 都要有真实 product entry/composition evidence；组件测试不能替代 E2E。

## 2. Phase 总览

| Phase | 任务 | 交付 | 依赖 |
|---|---|---|---|
| P0 Spec freeze | P0-01…04 | 契约、IA、schema、威胁模型冻结 | 无 |
| P1 Runtime extraction | P1-01…07 | `app-runtime` + controller；TUI 零回归 | P0 |
| P2 Web foundation | P2-01…09 | `apps/web`、`web-server`、local auth、SSE | P1 |
| P3 Core session UX | P3-01…10 | session/chat/composer/model/permission/tool/undo | P2 |
| P4 Management | P4-01…08 | Memory/Skill/MCP/Plugin/settings/status | P3 + 各 runtime 能力 |
| P5 Observe & review | P5-01…08 | activity/shell/subagent/telemetry/logs/review | P3/P4 |
| P6 Hardening | P6-01…11 | security/perf/a11y/compat/release evidence | P2–P5 |
| P7 Local beta | P7-01…06 | docs、packaging、beta gate | P6 |
| F1 Local automation | F1-01…05 | 受控 scheduler | beta 后独立 |
| F2 Remote/team | F2-01…08 | 远程/微信/团队研究与独立项目 | 长期硬门 |

关键路径：

```text
P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7
                            ├────────→ F1
                            └────────→ F2（长期，不与首版并行实现）
```

## 3. P0 — 规范与契约冻结

### P0-01 · 功能矩阵与状态基线

- 以 §22 W-01…W-18 建 capability rows，每项记录 source、entry、composition、evidence、state、blocker。
- 从现有 §16 读取依赖能力状态；`partial`/`implemented-unwired` 不得标 Web ready。
- 把 CodeBuddy 参考功能逐项归入 Now/Later/Long-term/No，未分类=0。
- **交付**：更新后的 §16 + issue/任务映射。
- **Exit**：产品、安全、runtime owner 同意首版范围和远程后置。

### P0-02 · API 与 view-event schema

- 在 `packages/shared` 或独立 private contract 包定义 `/api/v1` request/response、error、view/control event schema。
- CoreEvent 只引用附录 D 类型，不复制 event name/payload。
- 冻结 idempotency、revision、cursor、pagination、secret presence 和 unavailable 表达。
- 生成 browser/server 双端类型，禁止手写两份 interface。
- **Tests**：roundtrip、unknown field、large payload、version skew、golden corpus。
- **Exit**：schema 可生成、双端消费、附录 B error registry 同步。

### P0-03 · 安全威胁模型

- 攻击者：恶意网页、恶意模型输出、恶意项目、恶意 MCP/plugin、同机其他用户/进程、过期标签页。
- 资产：workspace 文件、credential、session、permission authority、shell、Memory、config、telemetry。
- 冻结 fragment nonce exchange、HttpOnly session、Origin/Host/CSRF、CSP、remote image、Markdown sanitizer、rate/size limits。
- 为 DNS rebinding、CSRF、XSS、path traversal、stale/replay decision、secret exfiltration 建 deny corpus。
- **Exit**：security reviewer 接受 loopback threat model；非-loopback 明确不可用。

### P0-04 · UX 行为冻结

- 产出 route map、desktop/tablet wireframe、loading/empty/error/unavailable/permission/danger states。
- 冻结键盘行为、焦点、interrupt 与 Escape 冲突、dirty draft 恢复。
- 冻结 session/tool/permission/subagent 的状态机文案。
- **Exit**：无关键页面依赖实现人员临场决定；所有 destructive action 有 preview/confirm/recovery。

## 4. P1 — 抽取 UI-neutral application runtime

### P1-01 · Inventory CLI composition root

- 对 `createProductionPorts` 按 domain 列出构造、I/O、host adapter、controller、UI import、副作用与 cleanup。
- 用 graph/call trace 确认每个对象的入/出依赖和生命周期。
- 识别 CLI-only：TTY、readline、stdout、browser open、command formatting。
- 识别 shared：session、trust、config、provider/router、tools、permission、storage、extensions、status。
- **Exit**：inventory 无未分类 import/side effect。

### P1-02 · 建立 `packages/app-runtime`

- 新建 private package，定义 `AppRuntime`, `RuntimeHostPorts`, `RuntimeCapabilities`, `RuntimeShutdown`。
- 把界面无关的 `SessionPort/InteractiveSession` 重命名/迁移为 controller contracts；保留兼容 adapter。
- 构造函数只接显式 host ports，不直接读取 stdin/stdout 或打开浏览器。
- **Tests**：依赖图、no CLI/UI imports、生命周期 unit/integration。

### P1-03 · SessionController

- 支持 list/create/resume/submit/interrupt/end/snapshot/changes/undo preview/commit。
- 一个 session 一个 turn mutex；所有 mutation 带 idempotency 和 revision。
- 统一 attach SessionStore/Telemetry/EventBus/subagent cleanup/background shell cleanup。
- **Tests**：并发提交、interrupt、resume、double end、storage failure、shutdown drain。

### P1-04 · Domain controllers

- 迁移/适配 Workspace/Trust、Config、Memory、Skill、MCP、Plugin、Status、Telemetry、Review controller。
- controller 返回 transport-neutral DTO，不返回 Ink node、ANSI、Node stream、raw secret 或 provider object。
- capability unavailable 使用 typed reason，不以 throw/空数组表达。
- **Tests**：CLI 当前行为 parity + unavailable corpus。

### P1-05 · PermissionController

- PermissionManager 仍为唯一决策源；controller 只暴露 sanitized pending snapshot 和 typed decisions。
- 冻结 request revision、expiry、session/subagent ownership、decision scope availability。
- disconnect 无隐式决策；shutdown 统一 deny/cancel。
- **Tests**：跨 session、重复/stale/replay、queue、MCP fatigue、danger flags。

### P1-06 · `ui-model` 归属整理

- 将 status formatter、permission SafeDisplay、session candidate、transcript reducer 等界面无关部分迁入 `ui-model` 或 `app-runtime`。
- `packages/ui` 保留 Ink components/hooks/terminal interaction。
- 所有 control character/ANSI/bidi sanitization 在 UI-neutral 边界可复用。
- **Tests**：TUI golden 未变化；Web-ready plain DTO 无 ANSI。

### P1-07 · CLI/TUI 回归门

- `apps/cli` 改为通过 `app-runtime` adapter 组装；保持现有 CLI 命令和 Ink 行为。
- 跑 direct tests、CLI/TUI integration、session resume、permission、extensions、status。
- 记录 bundle size/startup time 前后对比。
- **Exit**：TUI/CLI 真实入口 same-SHA 通过；无 Web 代码也可独立工作；重复 composition=0。

## 5. P2 — Web 基础设施

### P2-01 · 创建 `apps/web`

- React DOM + Vite，TypeScript strict，route-level code splitting。
- 只依赖 generated API client、UI libraries 和 browser-safe `ui-model`。
- 建 theme tokens、layout primitives、error boundary、i18n、test harness。
- **Tests**：browser bundle server-only dependency scan。

### P2-02 · 创建 `packages/web-server`

- loopback HTTP listener、static assets、API router、schema middleware、request id、limits。
- host/port validation；首版 host enum 只有 `127.0.0.1`/`::1`。
- 所有 controller 通过 constructor injection。
- **Tests**：bind、port conflict、invalid host、graceful shutdown、oversized request。

### P2-03 · Browser session security

- fragment nonce 生成/exchange、HttpOnly SameSite cookie、CSRF token、exact Origin/Host。
- nonce 单用、短期、constant-time compare；server restart/session rotate 失效。
- CORS disabled、iframe disabled、安全 header/CSP。
- **Security tests**：CSRF、DNS rebinding、foreign Origin、nonce replay/leak、cookie fixation。

### P2-04 · API client 与错误模型

- 从 schema 生成 typed client；统一 abort、timeout、request id、idempotency、revision conflict。
- error boundary 显示 user action，不泄漏 stack/secret。
- mutation 不因网络错误自动生成新 idempotency key。
- **Tests**：offline/reconnect/409/503/version skew。

### P2-05 · SSE gateway

- CoreEvent passthrough、view/control events、cursor、heartbeat、bounded per-client queue。
- cursor retention 有界；过期发送 resync；client snapshot reducer 幂等。
- hidden tab/slow client 不阻塞 EventBus listener。
- **Load tests**：高频 delta、10 clients、slow client、disconnect storm、memory bound。

### P2-06 · Bootstrap 与 capability discovery

- `/bootstrap` 返回 server/version/workspace/trust/capabilities/routes availability，secret-free。
- 前端 route/menu 基于 capability reason 渲染 enabled/unavailable，而不是隐藏所有失败。
- **Tests**：各平台/native/plugin/provider 缺失矩阵。

### P2-07 · `volund web` CLI 入口

- citty command：`--cwd`, `--port`, `--no-open`, `--new-instance`, `--log-level`。
- 首版不得有通用 `--host`；若为内部实现保留参数，parser 仍只接受 loopback enum。
- 复用 path guard/trust/config；输出 URL/PID/cwd/security/shutdown instruction。
- **E2E**：CLI spawn→browser bootstrap→SIGINT drain。

### P2-08 · App shell

- workspace header、sidebar、route outlet、command palette、health/connection banner、shortcut overlay。
- desktop/tablet responsive，skeleton/empty/error/unavailable 状态齐全。
- **A11y tests**：landmarks、skip link、focus order、drawer。

### P2-09 · Foundation gate

- 独立 security review，检查 server bind、nonce/cookie/CSRF/Origin/CSP、bundle imports。
- same-SHA 浏览器 E2E 证明只读 bootstrap，无 Agent 功能也能安全启停。
- **Exit**：P2 全通过后才允许接 submit/permission 等有权 mutation。

## 6. P3 — 核心 Session 与 Agent UX

### P3-01 · Session list

- pagination/index、search/filter、running/waiting/error state、new/resume/end/rename/export。
- 不递归全盘扫描；session metadata index 损坏可重建且诚实提示。
- **E2E**：10k sessions、missing/corrupt/newer-version JSONL。

### P3-02 · Session snapshot/reducer

- 从 persisted events 构造 transcript/tool/activity；live SSE 增量合并。
- event id 去重、cursor resync、stream completed reconciliation。
- **Tests**：refresh mid-stream、subagent bubbled duplicate、out-of-order control、aborted turn。

### P3-03 · Chat renderer

- Markdown/code/tool/error/thinking/usage UI；虚拟化长会话。
- remote image off、HTML sanitized、external link policy、copy code。
- **Security**：XSS/URL/control/bidi corpus。

### P3-04 · Composer/attachment

- draft、history、slash、`@`/`@@`/`@!`/`#sess_`、file/image attachment chips。
- server-side candidate/search/path guard；二进制 reference-only。
- **E2E**：paste/drop/path escape/size/type/count/missing attachment。

### P3-05 · Model/provider controls

- alias/provider/model picker、capability、source chain、single-turn override。
- only supported parameter inputs；unavailable/unauthenticated health。
- **Tests**：provider matrix、session vs turn scope、missing usage/cache。

### P3-06 · Permission queue

- global badge + session inline card；SafeDisplay、scope options、danger banner。
- allow/deny mutation 使用 revision + idempotency；keyboard 无误触快速键。
- **Security E2E**：forged/stale/cross-session/replay/disconnect/timeout。

### P3-07 · Tool activity

- lifecycle cards、duration、result/error、bounded detail；tool-specific safe renderers。
- 未知插件/MCP tool 使用通用 schema renderer，不插 HTML。
- **Tests**：large/binary/control/secret output、failed/blocked hook。

### P3-08 · Changes/diff/undo

- session-attributed effect list、diff viewer、backup state、undo preview/commit。
- external dirty changes 明确区分；CAS conflict fail closed。
- **E2E**：preexisting dirty worktree、concurrent edit、large diff、undo partial failure。

### P3-09 · Interrupt/recovery

- stop turn/end session、connection lost、provider retryability、server draining UI。
- mutation retry 仅复用 idempotency key；草稿不丢。
- **E2E**：interrupt during stream/tool/permission、server restart、tab duplicate。

### P3-10 · Core UX gate

- 真实 local server + browser + app-runtime + SessionStore 全链路。
- 至少一个 native sandbox boundary test；真实 Provider 留 external gate 或在有凭据环境执行。
- **Exit**：new→submit→stream→permission→tool→persist→resume→undo 可重复通过。

## 7. P4 — 管理面板

### P4-01 · Memory

- list/search/detail/CRUD/pin/import/export；scope/source/sensitivity/recall metadata。
- 保留 ACL、permission、preWrite hook；diagnostic 不展示 secret body。
- **E2E**：跨 workspace deny、restart persistence、import conflict、redacted export。

### P4-02 · Skills

- user/project/interop/plugin scope inventory；install/uninstall/enable/disable/activate/show/validate/rescan。
- 所有 source 和 trust 语义与 CLI 白皮书一致。
- **E2E**：local/git source、untrusted project、disabled persistence、session activation。

### P4-03 · MCP

- list/status/tools/test/inspect/add/remove/enable/disable/reload/auth state。
- credential 仅 keyref/presence；tool set trust gate、fatigue guard 可见。
- **E2E**：stdio/http、needs-auth、tool set changed、secret redaction、rate limit。

### P4-04 · Plugin

- builtin/dev/market inventory、compatibility、permissions、doctor、state action。
- respect deny-only/Kernel/Catalog；unavailable 不提供隐藏 action。
- 声明式 UI contribution schema + sanitizer；第三方 executable UI=0。
- **E2E**：contained state、invalid manifest、disabled persistence、doctor truthfulness。

### P4-05 · Hooks

- list/filter/show/recent timing；test 只 dry-run，输入 schema/大小限制。
- enable/disable 走 owner plugin/config，不新增旁路。
- **Tests**：untrusted output、timeout、oversize、control chars。

### P4-06 · Settings

- schema-driven global/project editor、effective source、validation、impact/restart preview、CAS write。
- secret presence/set/replace/clear；UI preferences separate。
- **E2E**：forbidden override、config hash/trust、concurrent write、atomic failure、secret scan。

### P4-07 · Status

- 复用 §11.3.14 view model；不在 Web 重算 pricing/cache hit/context。
- native/provider/extension unavailable 诚实显示。
- **Parity test**：`volund status --json` 与 `/api/v1/status` semantic diff=0。

### P4-08 · Management gate

- CLI/TUI/Web inventory/state parity suite。
- 对每个 `partial`/`implemented-unwired` capability 验证 Web 不可误操作。
- **Exit**：无管理页面直接读写底层文件或 secret store。

## 8. P5 — 可观测性与 Review

### P5-01 · Global activity

- running sessions、turns、tools、permissions、subagents、shells 的聚合投影。
- 每项跳回 owner session；跨 session interrupt/decision 保持 ownership 校验。

### P5-02 · Background shell

- inventory、bounded tail、dropped bytes、pause scroll、kill、脱敏下载。
- 不提供 stdin/任意新 terminal；control chars sanitized。

### P5-03 · Subagent lineage

- parent/child tree、budget、agentType、tool/status/result；event id 去重。
- parent/child interrupt 和 cleanup E2E。

### P5-04 · Telemetry dashboard

- local usage/cost/tool latency/allow-deny/sandbox/provider health；时间和 scope 过滤。
- unknown 字段不伪 0；默认无网络。
- chart 需有表格/文字替代和可访问 tooltip。

### P5-05 · Logs/diagnostic bundle

- structured paginated log、filter、bounded detail、secret-safe export preview。
- diagnostic mode 明确 banner/expiry；无自动 upload。
- secret corpus 和大文件性能测试。

### P5-06 · Code Review

- §17 form/progress/report/finding browser；schema 与 CLI JSON 相同。
- external editor deep link 必须 user initiated；不自动执行修复。
- injection、read-only tool policy、gate exit semantics E2E。

### P5-07 · Command palette/shortcuts/i18n

- 所有 route/action 有可发现命令；危险 action 不能只靠快捷键触发。
- 中英文、date/number formatting、error code 保持原文。

### P5-08 · Observe gate

- activity 与原始 CoreEvent/sample 对账；usage/status 与 CLI parity。
- browser page hidden/重连/长时间运行 8h soak，无 queue/DOM/memory 无界增长。

## 9. P6 — 安全、性能、可访问性与兼容加固

### P6-01 · Web attack corpus

- CSRF、DNS rebinding、Host/Origin spoof、nonce replay、cookie fixation、CSP bypass、XSS、open redirect。

### P6-02 · Local data corpus

- path traversal/symlink/TOCTOU、sensitive prefix、attachment oversize、JSON bomb、log injection、bidi/control。

### P6-03 · Authority corpus

- permission forged/stale/replay/cross-session、idempotency collision、revision conflict、server restart、danger flags。

### P6-04 · Extension corpus

- MCP fatigue/secret、plugin manifest/contribution、hook output、unknown tool renderer、Kernel contained state。

### P6-05 · Secret audit

- HTTP capture、SSE capture、localStorage/cookie、browser console、server logs、diagnostic bundle、source map、bundle string scan。
- 结果要求 raw credential/token=0；presence metadata 可白名单。

### P6-06 · Performance suite

- cold/warm startup、10k session list、5k message transcript、high-rate stream、large diff/log、10 clients、8h soak。
- 记录 p50/p95/max、RSS/browser heap/DOM nodes/event queue。

### P6-07 · Accessibility suite

- axe、keyboard-only、screen reader smoke、focus restoration、contrast、reduced motion、zoom 200%。

### P6-08 · Cross-platform/browser

- macOS/Linux mandatory；Windows 跟随 native Tier truthfulness。
- Chrome/Edge/Firefox current；Safari current on macOS。平台不可用能力明确标识。

### P6-09 · Version/upgrade

- frontend/server build id mismatch、API version skew、old session/new schema、cache bust、rolling restart（本地单进程）。

### P6-10 · Independent review

- architecture review：composition duplication=0、dependency boundary。
- security review：local server/browser authority。
- UX review：CodeBuddy 功能取舍、关键旅程、error/unavailable states。

### P6-11 · Hardening exit

- blocker/critical=0；important 有 owner/明确 release disposition。
- 性能和 a11y 预算通过；same-SHA CI 和证据包完整。

## 10. P7 — 本地 Beta 交付

### P7-01 · 构建与打包

- `apps/web` 产物使用 content hash，随 CLI/npm/standalone 包分发。
- `web-server` 可靠定位静态资源；开发模式与生产模式行为分开。
- source map/许可清单/第三方字体图标策略明确。

### P7-02 · CLI/standalone 集成

- npm 安装、npx、standalone 启动 `volund web`；资源路径、只读安装目录、临时目录、退出清理。
- 不新增独立常驻 daemon 或自启动项。

### P7-03 · 文档站

- 快速开始、功能导览、安全模型、设置、扩展管理、故障排查、限制、远程未支持。
- 公共 API/TypeDoc 如有新增必须 regenerate，再跑 docs guard/build。

### P7-04 · Release evidence

- exact SHA、平台/browser matrix、tests、security/a11y/perf report、依赖许可、changeset、artifact hash。
- 真实 Provider/签名/发布等外部 gate 单独记录。

### P7-05 · Beta rollout

- opt-in beta；收集仅本地 crash/diagnostic，由用户显式导出。
- 明确 downgrade/disable 路径；Web 失败不影响 CLI/TUI。

### P7-06 · Beta exit

- §22.15 Definition of Done 全勾选。
- capability matrix 对选定 Web scope 达到 `verified-ci`；发布动作完成后才可 `release-ready`。

## 11. F1 — 本地定时任务（首版之后）

### F1-01 · Scheduler ownership

- 决定前台 server、用户级 daemon 或 OS scheduler；不得在三个实现间隐式切换。

### F1-02 · Task contract

- 冻结 cwd/config hash/model/budget/tool allowlist/network/timeout/retry；禁存 dangerous skip。

### F1-03 · Trust/permission

- 每次运行重新验证 trust/config/plugin/MCP tool set；无用户在场时默认 deny 未预授权能力。

### F1-04 · Persistence/recovery

- missed run、sleep/reboot、overlap、clock change、duplicate prevention、log retention。

### F1-05 · 独立发布门

- threat model、E2E、OS matrix、clear disable/uninstall；不因 Web beta 自动启用。

## 12. F2 — 远程、团队与微信/企微（长期）

本阶段只允许在本地 beta 稳定后立独立规格，不能提前在 P2 server 留公开监听旁路。

### F2-01 · Product decision

- 明确是 direct LAN、user tunnel、hosted relay 还是 team service；每种 trust/成本/隐私不同，不混做。

### F2-02 · Identity/device

- 用户、设备、实例身份；pairing、短期 token、rotation、revocation、lost-device recovery。

### F2-03 · Transport

- E2EE/relay trust、forward secrecy、replay protection、rate limit、offline queue、audit。

### F2-04 · Remote authority

- 远程 prompt、interrupt、permission decision 的 actor 可见、scope 限制、step-up confirmation。

### F2-05 · Multi-instance/team

- instance discovery、RBAC、workspace ownership、session share、conflict、retention、audit export。

### F2-06 · 微信/企业微信 adapter

- 仅消息/通知 adapter；不持有 filesystem/tool/permission authority；敏感操作回到可信 UI 二次确认。

### F2-07 · Abuse/privacy/compliance

- spam、credential stuffing、relay abuse、data residency、retention、account deletion、incident response。

### F2-08 · Independent gate

- 独立安全评审、渗透测试、真实网络/设备证据和人类批准；不复用 loopback beta 的 release-ready 状态。

## 13. 建议 issue 切分

| Epic | Issues | 说明 |
|---|---|---|
| WEB-ARCH | WEB-001…010 | P0/P1，composition 与契约 |
| WEB-GATEWAY | WEB-011…020 | P2，本地 server/security/SSE |
| WEB-SESSION | WEB-021…035 | P3，chat/permission/tool/undo |
| WEB-MANAGE | WEB-036…047 | P4，Memory/Skill/MCP/Plugin/settings |
| WEB-OBSERVE | WEB-048…057 | P5，activity/telemetry/logs/review |
| WEB-HARDEN | WEB-058…070 | P6，security/perf/a11y/platform |
| WEB-RELEASE | WEB-071…078 | P7，package/docs/beta |
| WEB-AUTO | WEB-101…105 | F1，后续独立 |
| WEB-REMOTE | WEB-201…208 | F2，长期独立 |

编号只是本计划的稳定引用；创建外部 issue 时应记录真实链接，不能把编号存在当作任务已创建。

## 14. 每个任务的统一完成证据

每个 task/PR 必须记录：

1. spec subsection 和受影响 capability row。
2. exact base/head SHA、scope paths、dirty-file ownership。
3. runtime entry、composition wiring、不可达/降级路径。
4. direct test、integration/E2E、security negative test 和命令 exit status。
5. browser/OS/arch/Node 版本；涉及 native/Provider 时标真实或 fixture。
6. secret scan、`git diff --check`、build/typecheck/lint。
7. docs/changeset/compat/migration disposition。
8. 未完成 external gate 和下一条可执行命令。

状态只能使用 §10 的 `missing`、`partial`、`implemented-unwired`、`verified-local`、`verified-ci`、`external-pending`、`release-ready`。UI 截图、组件 story、mock Provider 或单个包测试不能单独把 capability 提升为 `verified-local`。

## 15. 第一批可执行任务

实际实现应按以下顺序开始：

1. `P0-01`：把 §22 W-01…W-18 录入能力矩阵并冻结状态。
2. `P1-01`：生成 `createProductionPorts` composition inventory 与 call/dependency map。
3. `P0-02`：基于 inventory 冻结 controller/API/view-event contract。
4. `P0-03`：完成 loopback threat model 和 security corpus。
5. `P1-02`：仅在前四项 review 通过后创建 `packages/app-runtime`。

首条实现命令不应是创建 React 页面，而应是运行/补齐 composition root 的现有回归测试并记录基线；否则后续无法证明抽取没有改变 CLI/TUI 行为。
