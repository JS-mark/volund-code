> ↩ [返回索引 (README)](./README.md) · ← [上一章: §13 文档站 IA + 官网](./13-docs-site.md) · —

---

## §14 首次运行 UX / Onboarding

用户 `npm i -g \@volund/cli` 后第一次跑 `volund` 时的完整体验；兼容窗口内 `npm i -g volund-code` 与 `volund` 仍可用。

### 14.1 目标

- 从零到"发第一条消息"**≤ 60 秒**
- **零阅读文档也能开始**
- 隐私与安全**首屏就说清**（不给"默认上报"的机会）

### 14.2 首次运行流程

```
$ volund

┌────────────────────────────────────────────────────────────┐
│  Welcome to Volund CLI 👋                                  │
│  An open, model-agnostic AI coding CLI.                     │
│                                                             │
│  This is your first run. Let's set things up (60s).         │
└────────────────────────────────────────────────────────────┘

Step 1 of 3 · Choose a provider
  ▸ Anthropic  (Claude Sonnet 4.5)
    OpenAI     (GPT-4o)
    Gemini     (Gemini 1.5)
    Ollama     (local models — no API key)

  [↑↓ move  Enter select  ? help]

Step 2 of 3 · Log in
  How to authenticate:
  1. Get an API key: https://console.anthropic.com/settings/keys
  2. Paste it below (won't be echoed; stored in your OS keychain)

  API key: ●●●●●●●●●●●●●●●●●●●● [Enter]

  ✓ Verified: model claude-sonnet-4-5 accessible
  ✓ Saved to macOS Keychain             (verify-first, save-second)

Step 3 of 3 · Your first task
  Try one of these, or type your own:
  • "Explain the code in this directory"
  • "Fix the failing test in tests/foo.test.ts"
  • "Add a README section for installation"

  > _
```

**Ollama 分支（选 Ollama 时 Step 2 变形）**：

```
Step 2 of 3 · Connect to Ollama
  Ollama runs locally, no API key needed.

  Endpoint: http://localhost:11434                 [Edit]

  ✓ Ollama reachable (version 0.4.2)
  ✓ Models detected: llama3.1:70b, qwen2.5-coder:32b
    Pick one for default:  ▸ qwen2.5-coder:32b
                             llama3.1:70b
```

- Endpoint 可改成远程 Ollama（`http://<host>:11434`）
- ★ **远程 Ollama 明文门（REVIEW-r6 P1-8）**：endpoint 非 `localhost` / `127.0.0.1` / `::1` 时，Ollama 默认无 auth + 明文 HTTP → prompt/代码明文过网。交互模式**必须**弹红条警告："non-local Ollama endpoint has no auth and sends prompts in plaintext; use only over trusted network / VPN / SSH tunnel"，需用户**显式确认**（或加 `--dangerous-plaintext-ollama` flag）才继续；非交互模式默认拒绝远程明文 Ollama，需显式 flag。HTTPS endpoint（`https://`）不触发此门。telemetry 发 `ollama.plaintext_remote.acknowledged` / `.declined`。
- 若 endpoint 不可达 → 提示 `ollama serve` 或改地址；不写任何 credential（Ollama 走 URL only）
- 若 model 列表为空 → 提示 `ollama pull <model>` 后重试

### 14.3 关键设计决策

**Provider 选择顺序**：Anthropic 放第一（品类领导者感）；Ollama 最后（"高级"感）。可用 flag `--provider anthropic` 跳过 step 1。

**API key 输入**：
- 输入时**不回显**（终端 mask）
- 输入后**先验证**（发一个便宜的 test 请求，比如 count_tokens 或 tiny completion）
- 验证失败给具体原因（网络？key 错？quota？）
- 验证通过才写 keychain
- 建议加 `--api-key-stdin`：`echo $KEY | volund login anthropic --api-key-stdin` 让脚本用户跳过 TUI

**存储位置默认**：
- macOS：Keychain
- Linux：libsecret（若装了）→ fallback 加密文件
- Windows：Credential Manager

任一失败 → 让用户选加密文件 or env 模式，**明确告知**"encrypted file at ~/.volund/credentials.enc, unlock with passphrase"。

**隐私首屏声明**（step 1 前一个屏）：

```
Before we start:
  • Volund saves session logs LOCALLY to ~/.volund/sessions/
  • Volund does NOT send analytics anywhere by default
  • Your prompts and code are only sent to the provider you choose
  • You can review or disable anytime: volund telemetry status

  [Continue]
```

**明确让用户看到"默认本地"**。首次开机是最好的信任建立时机；说清楚以后每一次 telemetry 相关操作都不会显得可疑。

### 14.3b 沙箱 Tier 首屏披露（Sandbox Disclosure）

> **产品硬约束**：沙箱是 Volund CLI 的核心卖点（见 [SANDBOX-COMPAT-r1 §S1](./SANDBOX-COMPAT-r1.md)）。onboarding 阶段必须**在写任何 config 之前**明示当前平台的沙箱等级；用户无法在 UI 隐藏此信息（可用 `--no-splash` 但 telemetry 事件仍写）。

**披露时机**：Step 1 之前，与"隐私首屏声明"同屏或紧邻下屏；每次 volund-sandbox 版本或 Tier 判定变化时也再显示一次。

**判定入口**：`volund-sandbox --probe`（见 [SANDBOX-COMPAT-r1 §S7](./SANDBOX-COMPAT-r1.md)）返回 `{ tier, mechanism, degradation_reasons[] }`。

**Full Tier（macOS 14+ / Linux 5.13+ landlock+seccomp / Windows Tier 3 WFP）**：

```
Sandbox: FULL  🛡
  • Mechanism: sandbox_init(sbpl) / landlock v3 + seccomp / AppContainer + WFP
  • Escape tests: 12/12 passed
  • Details: volund sandbox status
```

**Partial Tier（Linux landlock v1 无 seccomp / Windows Tier 2 AppContainer 无 WFP）**：

```
Sandbox: PARTIAL  ⚠
  Some restrictions are enforced, some are best-effort:
  • Filesystem access:  ✅ enforced (landlock v1)
  • Syscall filter:     ❌ unavailable (kernel < 3.17 or missing CAP_SYS_ADMIN)
  • Network egress:     ⚠ heuristic only
  What this means:
  • Malicious code can still make outbound network calls even after Volund denies them at the tool layer
  • Consider using `--strict-sandbox` to refuse to run when Full unavailable
  Continue? [Enter] / Learn more [L]
```

**Weak Tier（Windows Tier 1 Job+Token / Alpine 无 landlock / WSL1 / QEMU-only 抽检环境）**：

```
Sandbox: WEAK  ⚠⚠
  Only coarse-grained isolation is available on this host:
  • Windows Job Object + Restricted Token (Tier 1, L2 baseline; r9 调整：Windows 推 L2)
  • No AppContainer, no WFP
  What this means:
  • Filesystem writes outside allow-list still blocked
  • Process cannot escalate privileges
  • BUT: network egress and IPC can only be filtered at the tool layer, not the OS layer
  Not recommended for untrusted plugins or untrusted repos.

  [ ] Continue with weak sandbox
  [ ] Upgrade guide (Windows 11 24H2 → Tier 2)
  [ ] Exit
```

> **r9 调整**：L1 阶段仅 mac/linux 4 target 接入 `volund-sandbox --probe`；Windows + musl 在 L2 接入后才出现 Weak/Partial Tier 披露。L1 在 Windows 上跑 volund 会提示"Windows 支持在 L2 版本提供，当前 L1 仅 mac/linux"。

**None Tier（`--dangerous-no-sandbox` 或探针失败）**：不允许静默进入；必须让用户显式输入 `I understand the risk` 才继续，且在 status bar 顶部常驻红色 `NO SANDBOX` 徽章。

**用户可选择的对齐 flag**：
- `--strict-sandbox` — 遇到 Partial/Weak 直接退出，仅 Full 允许启动（适合 CI）
- `--sandbox=full|partial|weak|none` — 显式声明可接受的最低等级
- `~/.volund/config.toml` 中 `[sandbox] minimum_tier = "partial"`（团队策略）

**telemetry 事件**（本地强制写，OTel opt-in）：
- `sandbox.probe.completed` — 首次探测完成，payload: `{ tier, mechanism, kernel/os_version, escape_pass_ratio }`
- `sandbox.tier.acknowledged` — 用户确认后
- `sandbox.tier.declined` — 用户拒绝并退出
- `sandbox.dangerously_disabled` — `--dangerous-no-sandbox` 触发
- `sandbox.probe.failed` — 探针崩溃 / 平台完全不支持

### 14.4 项目首次进入

用户在一个新项目里第一次跑 `volund`：

```
$ cd my-project && volund

┌─────────────────────────────────────────────────────┐
│ First time in this project:                          │
│   /Users/mark/my-project                             │
│                                                      │
│ Volund detected:                                     │
│   • Git repo (main branch: main)                     │
│   • package.json (Node project)                      │
│   • No AGENT.md yet                                   │
│                                                      │
│ Would you like to:                                   │
│   ▸ Just proceed                                     │
│     Generate an AGENT.md from your codebase   (L2)   │
│     Configure project-level settings          (L2)   │
└─────────────────────────────────────────────────────┘
```

> L1 阶段第一屏**只保留 `Just proceed`**，另两项灰显 + 标 `(L2)`（未启用），避免误导 MVP 用户；L2 上线后取消灰显。

**AGENT.md 生成（选项 2，L2）**：volund 主动扫代码（README / package.json / 主要文件），生成初版 AGENT.md 供用户 review + save 到 `<cwd>/AGENT.md`。类似 claude-code 的 `/init`。等 skills-runtime 完备后再上线，避免 L1 阶段扫描逻辑没沉淀就先做。

**Project trust（分层）**：

| 阶段 | cwd 内 read/search（Read/Grep/Glob） | cwd 内 write（Write/Edit/MultiEdit） | cwd 内 exec（Bash） | cwd 外一切 |
|---|---|---|---|---|
| **L1 (MVP)** | ✅ 默认 allow-session（§4.4 auto-allow） | ⚠️ 仍走 permission 决策链弹窗 | ⚠️ 仍走 permission 决策链弹窗 + sandbox 兜底 | ❌ 弹窗，默认 deny |
| **v2 project trust** | 未信任 cwd 一律弹窗；信任后同 L1 | 未信任 cwd 一律拒绝；信任后同 L1 | 未信任 cwd 一律拒绝；信任后同 L1 | ❌ 弹窗，默认 deny |

> "MVP 直接信任 cwd" **仅对读/搜索类工具生效**；写/执行类工具**仍走标准 permission 流程**，不因为在 cwd 内就跳过。此规则与 §4.4 一致。

> **★ config 内容信任 ≠ 工具权限信任**：本表只管"工具在 cwd 内外的弹窗策略"。**项目级 config 文件本身的加载**（`<cwd>/.volund/config.toml` / `mcp.toml`）走独立的 §8.3.1 信任门——克隆任意仓库时项目级 config 首次加载必须确认，且数据流向 key（provider baseUrl / telemetry sink 等）禁止项目级覆盖（防 endpoint 重定向偷 API key / telemetry 外传，见 REVIEW-r7 NEW-P0-1）。两者独立，互补。

### 14.5 引导中断与恢复

- 用户中途 Ctrl+C → 已保存的 credential 保留，未完成的步骤下次 `volund` 时从中断处继续
- `volund --reconfigure` 强制重跑 onboarding

### 14.6 非交互场景

用户在 CI / 脚本里跑 volund：

```
$ volund chat "review this diff" < diff.txt

volund: WARNING: no provider configured. Non-interactive mode.
        Set VOLUND_PROVIDER=anthropic and VOLUND_ANTHROPIC_API_KEY,
        or run `volund login` first in an interactive shell.
        Exit code: 2
```

- 检测到 stdin/stdout 非 TTY → 不进 onboarding，报明确错误 + 退出码
- 环境变量 + `--api-key-stdin` 覆盖所有交互

### 14.7 边界与安全清单

| 规则 | 强制点 |
|---|---|
| API key 输入**必须**mask（不回显） | login TUI |
| API key 输入**必须**先验证再存 | login 流程 |
| 首屏隐私声明**必须**在写任何配置前展示 | onboarding 顺序 |
| **沙箱 Tier 披露**必须在 config 写入前展示（§14.3b） | onboarding 顺序 + volund-sandbox --probe |
| **`--dangerous-no-sandbox` / None Tier** 必须要求用户显式输入确认句，不允许静默 | onboarding 拒绝路径 |
| **`--strict-sandbox`** 遇到 Partial/Weak 必须直接 exit(3)，禁止降级启动 | CLI 参数校验 |
| 存储位置降级路径**必须**告知用户 | login 流程 |
| 非交互模式**禁止**弹 TUI（改报错）；沙箱 Tier < 期望值时非交互模式退出码 3 | TTY 检测 + sandbox 检查 |
| 首次运行**不写**任何自动 telemetry event 到远端（本地仍写） | telemetry sink 默认 |
| **sandbox.probe.\* 事件**（§14.3b）本地强制写，OTel 上报仍需 opt-in | telemetry sink |

### 14.8 里程碑

- **L1（MVP）**：完整 3 步 onboarding + 首屏隐私声明 + **§14.3b 沙箱 Tier 披露**（**mac/linux 4 target 接入 `volund-sandbox --probe`**；Windows/musl L2 接入）+ API key 验证 + 项目首次进入检测（提示但不自动 gen AGENT.md）+ `--strict-sandbox` / `--dangerous-no-sandbox` 支持
- **L2**：`/init` 生成 AGENT.md + project trust 提示 + **平台扩面：Windows + musl 接入 `--probe`，Weak/Partial Tier 披露上线** + Windows Tier 2 披露文案更新（AppContainer 描述覆盖 Weak → Partial）
- **L3**：非交互模式完备错误码 + shell integration hints + Windows Tier 3（WFP）披露升级为 Full
- **L4**：`volund --reconfigure` + onboarding 分支：Ollama 无 key 快速路径 / API key OAuth flow + `sandbox.tier` telemetry 面板

## Future / v2

- Auto-update 机制（`volund update`）
- Project trust / cwd 首次信任提示
- **沙箱历史趋势面板**：`volund sandbox history` 展示历次 probe 结果与 escape 拒绝率
- 高级模型路由（role-based / cost-aware）

---

## 变更日志

| 日期       | 版本  | 内容                                                                                                                                                                                                                                                                                                                                     |
|------------|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-31 | §1 v1 | 初稿仓库布局                                                                                                                                                                                                                                                                                                                             |
| 2026-07-31 | §1 v2 | 依赖倒置修正；新增 auth/http-kit/context/telemetry；Skill/Plugin 边界                                                                                                                                                                                                                                                                      |
| 2026-07-31 | §1 v3 | provider-kit 去实现依赖；permission promptHandler 端口；ContextPolicy 移入 provider-kit；native-bridge 平台包分发；subagent RunnerFactory 注入；新增 router 包；telemetry 默认本地；plugin/skill 版本兼容                                                                                                                                       |
| 2026-07-31 | §2 v1 | 核心数据模型（Message / ContentPart 多模态 / AttachmentRef + handle 生命周期）；SessionState immutable + immer 结构化共享；EventBus 16 种事件谱；Runner 主循环伪代码；并行 tool 调用（permission 内部串行弹窗）；10 个 hook 拦截点；Subagent 生命周期（3 层深度上限 + 事件冒泡 + 隔离）；异常谱（含 Rust 崩溃 / sandbox 缺失 / 磁盘满 / keychain 锁定） |
| 2026-07-31 | §6 v1 | 插件系统：JS ESM 单文件 bundle；manifest.json 声明式权限；JSBridge（`volund.tools/hooks/commands/prompt/session/fs/exec/http/ui/storage/config/log`）；`node:vm` 能力控制 + AST 静态检查；PromptComposer 统一 system prompt 组合（builtin/skill/project/user/plugin 优先级 1000→50）；新增 `packages/plugin-sdk` 包（type-only，发布 npm）；`plugin-runtime` 新增 `core[type-only]` 依赖；插件间隔离；升级权限扩容再确认；MVP 分 L1-L4 里程碑 |
| 2026-07-31 | §3 v1 | Provider 抽象：`ProviderClient` / `ProviderRequest` / `ProviderChunk` / `ProviderCapabilities`；RawMeta 逃生舱（按 provider 命名空间）；四家 provider 适配差异表（Anthropic/OpenAI/Gemini/Ollama）；`ProviderError` 10 类分类 + Router/Runner 反应表；Router 契约（`RouterPolicy.pick/onError`）+ 4 种策略（Single/Fallback/Role/CostAware）；`@model` 显式路由 + alias 配置；边界与安全清单 |
| 2026-07-31 | §4 v1 | 工具体系：Tool 契约 + JSON Schema 输入验证；`PermissionSpec`（fs/bash/net/env）+ 8 步决策链 + 4 档 Decision（once/session/project/forever）；permission ↔ sandbox 双层安全；破坏性操作额外保护；内置工具清单（Read/Write/Edit/Bash/Grep/Glob/Todo 为 L1；MultiEdit L2；Task/WebFetch/WebSearch L3-L4）；ToolRegistry 名字前缀约定（`mcp:` / `plugin:`）；ToolResult 规范化（截断/脱敏/attachment）；边界与安全清单 |
| 2026-07-31 | §5 v1 | Rust 侧车：三个产物（volund-sandbox 独立 bin / volund-search napi / volund-fs napi）；平台沙箱实现（macOS sandbox-exec / Linux landlock+seccomp / Windows AppContainer 延后）；native-bridge 单点接入 + JS fallback；attachment handle 生命周期；沙箱 profile 从 PermissionSpec 生成；边界与安全清单 |
| 2026-07-31 | §7 v1 | Terminal UI：Ink 组件树；stream 30fps 自 throttle（上游不背压）；permission 弹窗串行队列；InputBox 多行/附件/slash/@alias 补全；无颜色 + `--json` 结构化输出；边界与安全清单 |
| 2026-07-31 | §8 v1 | 存储：纯文件（`~/.volund/` + `<cwd>/.volund/`）；session JSONL append-only（stream.delta 不落盘）+ replay；config.toml 分层（内置<全局<项目<env<flag）；credentials 三层 fallback（keychain / 加密文件 / env）；backups + GC；telemetry 默认本地；边界与安全清单 |
| 2026-07-31 | §9 v1 | 构建/CI/分发：pnpm workspace + catalog；turbo pipeline；CI matrix（ts 3 平台 + native 6 target）；changesets 发版；apps/docs 单独 VitePress 部署不发 npm；TypeDoc → docs API；rolldown 单文件 bin；边界与安全清单 |
| 2026-07-31 | §10 v1 | 里程碑总览：L1（Anthropic + 7 tools + 权限 + 存储，4-6 周）→ L2（OpenAI + context 压缩 + Skill + docs，3-4 周）→ L3（MCP + Plugin + subagent + FallbackRouter + Windows CI，4-5 周）→ L4（Gemini + Ollama + RoleRouter + WebFetch + 独立二进制，2-3 周）；每阶段 7 项完成闸门 |
| 2026-07-31 | §6 v2  | 插件补漏：6.11.1 hook 多插件执行顺序（numeric priority + 串行 pipeline + veto 短路）；6.11.2 资源守护 5 层（activate 10s / bridge call 5s / 500 calls/turn / ban / auto-disable）；6.11.3 `volund plugin doctor` 诊断命令；6.11.4 生命周期事件（session.start/end + permissions.changed）；6.11.5 升级迁移（manifest.migrations + volundVersion 校验） |
| 2026-07-31 | §6.5 v2 | 系统提示词补漏：6.5.1 builtin system prompt 草稿（`{{cwd}}`/`{{model}}` 模板变量 + 安全底线）；6.5.2 Skill 数据模型 + SKILL.md frontmatter yaml schema；6.5.3 三阶段 progressive disclosure（cold scan → index → activate）；6.5.4 AGENT.md 语义规则（从 cwd 向上遍历、不跨 home、CLAUDE.md fallback）；6.5.5 PromptComposer 输出示例（`<!-- source: ... -->` HTML 注释标签） |
| 2026-07-31 | §11 v1 | CLI 命令树设计（citty）：17 个顶层命令（含 `completion` / `hook`，`update` 留 v2）+ 全局 flag 集；交互 REPL 内 slash / `@alias` / `#tag` / `!cmd` 前缀；shell completion 生成；返回码约定；`--dangerously-*` telemetry 强制记录；分 L1-L4 落地 |
| 2026-07-31 | §12 v1 | 开源治理：Apache-2.0 主协议（含专利授权 + SPDX 头）；DCO v1.1 而非 CLA；SECURITY.md 响应流程（48h ack / 14d fix）；Contributor Covenant v2.1 CoC；CONTRIBUTING.md + RFC 流程（7 天冷静期）；`.github/` 治理仓库结构（CODEOWNERS + issue/PR 模板 + CI workflow）；BDFL → SIG 演进路径 |
| 2026-07-31 | §13 v1 | 文档站 IA：域名 `volund-code.dev`；VitePress 8 部署；完整站点信息架构（getting-started/concepts/guides/reference/cookbook/troubleshooting/plugins/skills/blog/changelog/roadmap/community）；官网首页 wireframe（hero + 6 特性 + 3 步上手 + demo GIF + 信任声明 + 社区）；MVP 品牌与视觉基线；CLI/API/config 自动生成；无追踪隐私默认 |
| 2026-07-31 | §14 v1 | Onboarding：60s 三步流程（provider 选 → API key 输入验证 → 首个任务）；API key mask 输入 + 先验证后落盘；首屏隐私声明（本地 telemetry / 无自动上报）；存储降级路径明示；项目首次进入检测 + `/init` 生成 AGENT.md（L2）；非交互模式明确错误码；`--reconfigure` |
| 2026-07-31 | review r1 | Self-review 修正一轮：§10 L1 "5 工具" → "7 工具"；§4 v1 changelog 澄清 MultiEdit L2 / Task 归 L3；§1.2 skills-runtime 补 `core[type-only]` 依赖 + auth→native-bridge 依赖说明为可选运行时；§11.2 顶层命令补 `completion`、`update` 明确归 v2、总数订正为 17；§11.3.9b 新增 `volund hook` 子章节；§11.3.10 doctor 输出按 L1/L2/L3/L4 分层展示 + `--json`/`--strict` flags；§11.3.2 `volund login` 明确 verify-first-save-second + `--skip-verify` 需 `--dangerous`；§11.7 里程碑同步；§14.2 补 Ollama 分支流程；§14.4 mockup 标 `(L2)` + "信任 cwd" 范围限定为 read/search，write/exec 仍走 permission；§6.5.4 AGENT.md priority 递减公式（`600 - 10*level`，下限 500，CLAUDE.md fallback 复用同槽位）；§10 加时间估算前提说明；§12.5 CONTRIBUTING.md 去重改为引用仓库文件 + 独立 12.5b RFC 触发清单；SECURITY.md `Supported versions` 表订正为 0.x pre-release 现实语义；CONTRIBUTING.md 分层 branching model（L1-L2 trunk-based，L3+ 引入 `next`） |
| 2026-07-31 | review r2 | **架构一致性修正**（用户反馈：Rust 沙箱应统一到插件，不该用 `node:vm`）：§6.4.3 重写：`node:vm` 方案作废，改为 `volund-sandbox --run-plugin` 独立子进程 + JSON-RPC 2.0 over NDJSON (fd 3) bridge；每插件一 Node 子进程，profile 从 `manifest.permissions` 生成；附件走 handle-token 模式（native pointer 不出主进程）。§5.2 volund-sandbox 能力表补"沙箱内执行插件 Node 子进程"。§5.3 拆为 `exec` 与 `--run-plugin` 两模式（3 段：5.3.1/5.3.2/5.3.3），共用 profile 生成与平台机制；插件模式额外禁 `ptrace`/`mmap w+x`。§5.8 边界清单新增 4 条（sandbox 唯一入口 / profile 由 native-bridge 生成 / 崩溃隔离 / RPC 白名单）。§5.9 里程碑：`--run-plugin` 归 L2；插件资源守护归 L3；Windows 插件宿主归 L4。§6.7 差量：plugin-runtime 新增 `native-bridge` 依赖 + 新增 `packages/plugin-runtime/runtime/plugin-host.mjs` 宿主脚本；`native-bridge` 新增 `runPlugin(opts) → PluginProcHandle` 原语。§6.8 安全清单重写（sandbox 语义替代 vm 语义 + 新增子进程崩溃隔离/stdout 限流规则）。§6.10 里程碑标注依赖 §5.9-L2。§6.11.2 资源守护由 5 层扩展到 7 层（新增 `setrlimit` + 心跳），且现在真正做到 CPU/RSS/fork 上限。§6.11.3 doctor 输出：VM state → Sandbox subprocess pid/rss/cpu + profile。§1.2 依赖表：`plugin-runtime` 新增 `native-bridge` 依赖。心智：AST 静态检查从"安全底线"降级为"作者友好检查"，真正的隔离靠 Rust sandbox + JSON-RPC 白名单 + manifest 三层。 |
| 2026-07-31 | review r3 | **一等公民规则 + auth 事件谱**：新增 §8.4.1 auth telemetry 事件谱（17 类事件：`auth.login.started` / `verify_requested` / `verify_result` / `stored` / `failed` / `cancelled` / `logout.completed` / `credential.resolved` / `credential.miss` / `keychain.error` / `encfile.unlock_prompted` / `encfile.unlock_result` / `migration.plaintext_found` / `migration.plaintext_moved` / `dangerously.skip_verify` / `mcp.keyref_created` / `mcp.plaintext_kept`），字段全部经 `shared.sanitize()` 脱敏；本地 sink 为默认，OTel opt-in；§8.7 补 2 条边界规则（分支必发事件 + payload 必脱敏）。AGENT.md §1.1 新增"一等公民架构（不可动摇）"两条：Rust 沙箱是安全基座、TS 是开发效率基座；§4.6 补 verify-first-store-second + MCP keyref + auth 事件上报硬约束；§4.7 重写为"Rust 沙箱 = 一等公民"，含适用范围表 + 平台机制 + 降级 + 永远禁止清单；§4.10.1 抽掉 `node:vm` 语义，改为 `volund-sandbox --run-plugin` 子进程 + JSON-RPC bridge 描述；§4.1 依赖图 plugin-runtime 加 native-bridge。CLAUDE.md §C0 新增"一等公民架构"镜像；§C3 plan mode 触发条件新增沙箱边界 / auth 事件谱；§C4 禁止事项去除过时 `vm.Context` 条，改为禁止 `node:vm` / `worker_threads` / 手动 profile / 绕过 verify-first / auth 事件缺失 / payload 未脱敏，共 5 条新增。 |
| 2026-07-31 | review r5 | **CLI 输入体验对齐**（用户反馈：对齐 claude-code 的图片粘贴 / `@` 语义 / 跨会话引用）：§7.5 InputBox 拆为 4 小节，7.5.2 新增剪贴板图片二进制粘贴（native-bridge stage → hash 落盘 → 输入行 chip 占位 → 提交时展开为 ContentPart，历史脱敏为占位）；7.5.3 新增 `@` **双模式选择器**语义（键入 `@` 弹 file / model 二选一 popup，`@@` 显式 file、`@!` 显式 model，明确不做启发式），file 分支落到 attachment 生命周期 + path-guard，目录展开上限 200；7.5.4 新增 `#sess_<id>` 输入语法（popup 候选按 mtime 倒序，chip 展开 strategy Tab 切）。§7.7 边界清单补 4 条（历史脱敏图片 / `@` 禁启发 / `#sess_` 走端口 / 跨用户拒绝）。§7.8 里程碑重排：L1 补 `@` 选择器 model 分支、L2 加 `@` file + 剪贴板图片二进制、L3 加 `#sess_` + `SessionContextReader`。§3.9 补 UI 入口交叉引用（说明 `@` 是选择器入口）。§8 新增 §8.5 "跨会话上下文引用（SessionContextReader）"5 小节（端口定义 / relevant + handoff 两 strategy / XML wrapper 注入 + 只存引用元数据不 duplicate 原文 / 权限模型（首次弹 allow-once/session/deny，`allow-session` 覆盖本 session 内所有跨会话读，跨用户 uid 拒绝，`permissionCache` key `session-context-read:*`）/ 5 条边界（脱敏 / maxTokens ≤ 12000 / 未知 id 明确报错 / 版本降级 / 禁递归展开））；下游子节顺移：原 8.5 Backups → 8.6，8.6 Telemetry → 8.7，8.7 边界 → 8.8，8.8 里程碑 → 8.9，里程碑同步补 SessionContextReader（L3）+ 可选向量索引（L4，opt-in）。§11.5 前缀表重写为 8 项含 `@` / `@@` / `@!` / `#sess_<id>` / `#<tag>` / `!<cmd>` / 拖拽粘贴 / 剪贴板图片，加"歧义规则"（`#sess_` 保留、`@` 无后续字符时开选择器、Esc 退出）。 |
| 2026-07-31 | review r4 | **Memory 系统 + `@include` 机制**（用户反馈：需要跨会话记忆 + md 文档递归引用）：spec 新增 §6.12 Memory 系统（12 小节：配置 / md 文件格式 / memory-guide 内置提示词 / 200 行限制的 4 层降级链 / MemoryBridge API / hook 谱 / `volund memory` CLI 子树 / 召回策略 / 新增 `packages/memory-runtime` 包 / pinned auto-inject / 与 Skill/AGENT.md 的边界 / 里程碑）；spec 新增 §6.5.6 `@include` 机制（语法 / 路径解析 / workspace+`~/.volund` 双白名单 + canonicalize+symlink 逃逸检测 / 递归深度 8（可配 32）/ 单 compose 展开次数 64 上限 / cycle 检测 / frontmatter 剥离 / debug marker / 错误占位不中断 compose / telemetry 事件 `prompt.include.expanded` + `prompt.include.failed` / 实现单点 `packages/core/src/prompt-loader.ts`）；§1.1 package tree 补 `memory-runtime/` + `plugin-runtime` 注释同步为 sandbox 子进程语义；§1.2 依赖表补 `memory-runtime` 行 + ASCII 图 memory-runtime 注入行；§6.7 差量补 `PromptLoader` 责任 + 三 contributor 共用 loader + 内置 `memory-guide.md` 资源 + `packages/memory-runtime` 新包；§6.9 对比表由 4 行扩到 6 行（加 Memory + AGENT.md），列头改"语言/维护方"，决策语说明 Skill vs Memory vs AGENT.md 三者取舍；§11.2 顶层命令 17 → 18（加 `volund memory`），§11.3 交叉索引到 §6.12.7；§8.2 存储布局树补 `~/.volund/memory/*.md` + `<cwd>/.volund/memory/*.md` + `index.jsonl` 摘要索引；§8.7 边界清单补 4 条（frontmatter 校验 / body 200 行 / 路径 canonicalize+escape / `volund.memory.*` 过 manifest.permissions）。AGENT.md §4.1 依赖图补 `memory-runtime`；新增 §4.14 Memory 硬约束（存储位置固定 / frontmatter 必填字段 / 200 行 4 层降级 / 模型主导 / 唯一召回路径 / 权限门 / 4 条禁止）；新增 §4.15 `@include` 硬约束（仅 volund prompt 管线 / 单点实现 / 只 md / 双白名单 / 递归安全 / frontmatter 剥离 / 错误不中断 / debug 可观测 / 3 条禁止）。CLAUDE.md 顶部 §4.14/§4.15 索引 + §C4 禁止事项新增 12 条（memory-runtime 单点 / frontmatter / 200 行 4 层 / 无 raw key / 无另起提示词 / 权限门 / prompt-loader 单点 / 只 md / 仅 prompt 管线 / 双白名单 / 修改 max_body_lines 需同步 guide）；§C7 提示触及 memory / `@include` 需先读 §6.12 / §6.5.6。 |
| 2026-08-01 | review r9 | **「设计本身好不好」独立复审 + 10 项处置**（详见 [REVIEW-r9](./REVIEW-r9.md)）。用户 5 指令 + 4 决策落地：(1) **新增 §8b ContextPolicy**（[08b-context-policy.md](./08b-context-policy.md)，三策略全规格化 Sliding L1 / Summary L2 / Semantic v2 + token 估算 + tool 配对保护 + summary untrusted 安全 + preCompact/postCompact 拦截型 hook + 插件 contributePolicy）；(2) **@ 选择器改统一 picker**（§7.5.3 重写：alias 置顶 ⭐ + 文件候选 📄 + 前缀过滤 + `@!` model / `@@` file，消除二选一 popup）；(3) **JSONL 分段加载**（§8.2b 新增：行级索引 + loadSession tailTurns + resume 只读最后 20 turn + 50MB GC）；(4) **Rust 全二进制化**（§5.2/5.6/5.7/5.8：search/fs 从 napi-rs .node addon 改独立二进制常驻 worker + IPC，三产物形态统一，消除 napi ABI 依赖，universal2 限制解除）；(5) **L1 平台范围砍 mac/linux 4 target**（Windows Tier1 + musl 推 L2；影响 §5/§9/§10/§1/§6a/§14.3b/AGENT.md/SANDBOX-COMPAT 全部硬约束表述分层；L1 时间 5-7 周→3-4 周，平台包 24→12）；(6) **stream 中断复用 tool_result**（§3.9a 规则 4：重跑时不重新执行已完成 tool，省 input token + 避免副作用 tool 重复）；(7) **hook 框架级 KV**（§2.5/§2.6/§6.4.1：`ctx.kv` / `volund.hook.kv` 命名空间 store，框架保证互斥，不再把并发竞态锅甩给作者）；(8) **codex fork 治理**（§5.1 + §5.12 新增：upstream 跟踪 + 安全公告 + 抽象层 + license 变更应急）；(9) **provider-plugin header-template 提前 L3**（PLUGIN-PROVIDER §P12：从 v2 提前到 L3，signing 仍 v2）；(10) **README + REVIEW-r9 汇总**。Memory（§6.12）维持现状（用户决策）。 |
| 2026-08-01 | review r10 | **三原则落地：AI-native 范式 + 自我进化 + Context 透明可控**（详见 [REVIEW-r10](./REVIEW-r10.md)）。用户三顶层原则 + 3 决策：(1) **AI-native 协作约定**（[§12.6b](./12-open-governance.md)：范式声明 + spec AI 可执行性标准 + 人在环检查点 5 类 + superpowers 协作流程；§12.7 BDFL 人决策+AI 执行；全局时间估算改「AI 迭代轮数」口径，L1 8-12 轮 / 总计 33-45 轮）；(2) **自我进化贯穿框架**（新建 [§15](./15-self-evolution.md) ~230 行：双层记忆 Memory(scope=tuning) 存模式 + tuning/*.jsonl 存参数 + 通用 OHAV 进化循环 + 接入点矩阵 ContextPolicy L2 / Router+Retry+Tool-timeout L3 / Sandbox 观察 only + 安全护栏[安全参数冻结/步长±10%/恶化回滚/可关闭/审计完整/不跨用户/脱敏] + 人机协作[小幅静默/大调整确认]；跨节接入点：§3.7 Router / §3.9a Retry / §4.3 Tool / §5 Sandbox 仅观察 / §6.12 Memory scope=tuning）；(3) **Context 透明可控**（[§8b.13](./08b-context-policy.md)：CLI `volund context show/diff/keep/unkeep/compact/policy` + TUI `/context` 面板[实时 token 占用+占比+压缩记录+K/C 快捷键] + hook 联动；§8b.14 ContextPolicy 作首个进化接入点；§8b.9 边界+2 / §8b.10 事件+2）；(4) **CLI 扩展**（§11.2 顶层命令 18→20 加 context/evolution；§11.3.12/13 子节定义；§11.4 slash 补 /context；§11.7 里程碑 L2 context+evolution / L3 evolution enable）；(5) **§12.5b RFC 补进化护栏变更需 RFC**。7 项处置全落地。进化边界明确（安全冻结/不全自动/不跨用户/不预测/可关停）。Memory 架构不变仅加 scope=tuning 标签。 |
| 2026-08-01 | review r10.1（一致性修复） | **复审发现并修复 4 处一致性瑕疵**：(1) **§9.9 时间口径对齐**：删除 L1 "3-4 周（r9 单人口径）"，改"8-12 轮 AI 迭代（r10）"+ 口径说明段，消除 §9 ↔ §10 矛盾（复审 P1）；(2) **§3.11 alias 里程碑澄清**：`@model` alias 解析随 §7.8 `@` 统一 picker 在 **L1** 落地（删除 L4 残留项），L4 只保留 RoleRouter（复审 P2）；(3) **§13.7 官网分析澄清**：MVP 不加任何分析（与 §13.8 "无追踪"边界一致），L2 起评估 Plausible 须配隐私页声明 + opt-out，永久不加 GA（复审 P2）；(4) **新建 L1 Release Checklist**（[RELEASE-CHECKLIST-L1.md](./RELEASE-CHECKLIST-L1.md)，复审 P3）：把散落各章的 L1 强制点 + DoD + CI matrix + dog-fooding 汇成单一可勾选清单，符合 §12.6b "spec 即 AI 可执行契约"。README + §10 加交叉引用。 |
| 2026-08-19 | r13 追加 | §3.7.2 新增 RouterHint.preferredProvider 补注（B7 截断续写的 provider 沿用机制，REM-63 实现同步）；附录 C 补录 preferences.* 两行 + verify-config-docs 通配覆盖（修正批次 3a 收口引入的文档/实现对撞） |
| 2026-08-16 | review r13 | **功能设计完整评审修正落地**（[REVIEW-r13](./REVIEW-r13.md) 25 项清单，P0×2 / P1×6 / P2×13 / P3×2）。安全：§2.6 hook 超时分域（builtin fail-closed + payload 尺寸闸，I10）；§5.8 native 探测启动时序契约（并行探测 + REPL 不等 + 三态 available + 下载可跳过，P1）。功能补缺：**新增 §17 Code Review**（[17-code-review.md](./17-code-review.md)，G1；r13 原案编号 §16，因 16 已被能力追踪占用改为 §17）；§4.3.1 Bash 执行语义 + 后台任务（runInBackground / ShellOutput / KillShell / 事件 17→19，G2+I11）；§4.3.2 Edit 完整契约（J3）；§2.7.1 自定义 agent 定义格式（G3）；§2.4 B7 截断续写（G5）；§8.6.2 回退边界 + /undo 选点规则（G4）；gh 依赖三处显式化（G6：RELEASE-CHECKLIST DoD / §4.4 auto-allow / §11.3.10 doctor）。实现契约：§3.2 tool_use 聚合规则（I1）；§4.4 glob 方言 picomatch + net origin 粒度（I2+D1）；§4.3.3 Read 默认值（D1）；**新增 §6.13 测试基建**（[06d-testkit.md](./06d-testkit.md)，I5）；§5.6.2 IPC max_line_bytes=4MB + sandbox 协议形态修正（I6+D1）；**新增附录 B/C/D/E**（错误码登记 / config 全量 schema / 事件 payload 字段表 / 20 条契约空白登记，I3/I4/I8/D1）；§7.6 --json 错误输出协议（D1）；§6.4.1 非交互 ui.* 降级（D1）；§8.3 未知 key 策略（I4）；§8.2 拒绝 session.snapshot（D1）；§8b.3 估算缓存生命周期（D1）；§5.3.1 exec+limits / §5.3.3 probe 键名 / §5.3.2 Windows pipe L2 / §5.8 resolver 四级链（D1）；§3.7.1 合成 tool_use id / §3.9a streamResume 护栏（D1）；§12.2 DCO bot/AI 署名（D1）；§13.6 reference 漂移检测（D1）。性能/测试/供应链：§9.10 性能预算表（P2/P5/T4）；§9.4 e2e smoke job（T2）；§9.5 npm org / provenance / NOTICE（S1/S2）；§7.5.3 picker 缓存策略（P3）。连锁同步：README 目录（§6d/§17/附录 B-E）、§11.2 顶层命令 20→21（+review）、§11.4 slash（+/review +/shells）、§11.7 与 16-capability-traceability 里程碑/矩阵同步。 |
