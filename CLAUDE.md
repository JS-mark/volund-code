# CLAUDE.md — volund Code

> [AGENT.md](./AGENT.md) 是通用工程约定的唯一事实来源；本文件只维护 Claude Code 特化补充。
> 通用约定只修改 `AGENT.md`，涉及 Claude Code 行为时同步审查并更新本文件的补充与索引。

## 与 AGENT.md 相同的部分

请阅读 [AGENT.md](./AGENT.md) 中的以下章节，本文件不再重复：

- §1 项目定位
- §2 技术栈基线
- §3 依赖版本策略（latest + pnpm catalog）
- §4 Monorepo 边界规则（**强约束**）
  - §4.1 依赖倒置原则（core 只依赖 kits，UI/storage/telemetry/hooks 反向订阅；type-only 约定）
  - §4.2 契约定义归属（Message/Tool/Runner/RouterPolicy/ContextPolicy 抽象唯一位置）
  - §4.3 Rust 单点接入
  - §4.4 单入口原则
  - §4.5 Provider / Tool 隔离（含 ProviderCapabilities）
  - §4.6 认证与网络（auth + http-kit 强制路由）
  - §4.7 权限与副作用（sandbox 强制 + MVP 例外 + permission promptHandler 端口）
  - §4.8 多模态与附件（ContentPart 联合类型 + Attachment 懒加载）
  - §4.9 上下文与成本（Usage/Cost 累计 + ContextPolicy 可插拔）
  - §4.10 Skill / Plugin 严格分工（含 §4.10.1 Plugin 硬约束 / §4.10.2 PromptComposer 强制路径 / §4.10.3 plugin-sdk 包约束）
  - §4.11 Rust 原生分发（平台包 optionalDependencies 模式）
  - §4.12 模型路由层强制（Runner 只持有 RouterPolicy 不持有 ProviderClient）
  - §4.13 遥测隐私强约束（默认本地，OTel opt-in）
  - §4.14 Memory 系统硬约束（存储/frontmatter/200 行/权限门/唯一召回路径）
  - §4.15 `@include` 机制硬约束（仅 volund prompt 管线，双白名单，只 md，深度 8）
- §5 代码规范
- §6 测试规范
- §7 提交规范
- §8 目录新增流程

## Claude Code 特化补充

### C0. 一等公民架构（不可动摇的两条）

1. **Rust 沙箱是一等公民** —— 项目的**安全基座**。所有执行第三方 / 用户 / 未审计代码的路径（Bash 工具、Plugin 宿主）**默认**走 `volund-sandbox` 独立进程 + syscall 隔离；TS 侧不允许自建 sandbox。绕过 = 破坏信任模型（详见 AGENT.md §4.7 + spec §5.3 / §6.4.3）。
2. **TypeScript 是开发效率基座** —— 业务、编排、UI、事件流全部 TS。Rust **不做** 编排、不做业务；单点通过 `native-bridge` 暴露原语（`exec` / `runPlugin` / `search` / `diff` / `countTokens`）。TS/Rust 边界靠 `native-bridge` **唯一入口**。

违反其一 = 架构 breach，PR 必拒。

### C1. Skill 使用偏好

- 涉及 UI 或视觉方案时使用 `frontend-design` / `design-taste-frontend` 技能。
- 修 bug 走 `superpowers:systematic-debugging`。
- 大改动先 `superpowers:brainstorming` → `writing-plans` → `executing-plans`。
- 完成前跑 `superpowers:verification-before-completion`。

### C2. 工具调用偏好

- 搜索优先用本仓库自带的 `volund-search`（Rust ripgrep 绑定），而不是 Grep/Glob。
- 大文件 diff 用 `native-bridge` 的 `computeDiff`，不要在 TS 里跑字符串对比。
- 修改 Rust 代码后必须 `pnpm build:native` 重新编译 addon。

### C3. Plan Mode 触发建议

以下情况请使用 EnterPlanMode 而不是直接改：
- 触及 §4 任一边界规则的重构
- 新增/删除一个 `packages/*` 或 `crates/*`
- 修改 Provider 抽象接口
- 修改权限模型
- **触及 Rust 沙箱边界**（`volund-sandbox` CLI 面、profile 生成、`--run-plugin` 协议）
- **修改 auth 事件谱**（spec §8.4.1，任何新增/删除事件都影响后期统计口径）

### C4. 禁止事项

- **禁止** 直接改 `packages/*/dist`（产物）
- **禁止** 手动写 `pnpm-lock.yaml`
- **禁止** 在 `packages/core` 里 import 任何具体 provider / 具体 tool / ui / storage / telemetry / hooks / mcp-client / plugin-runtime / skills-runtime / subagent（见 AGENT.md §4.1）
- **禁止** 在业务代码里出现 `process.exit(1)`（除 `apps/cli` 入口）
- **禁止** 在提交里附带 `console.log` 调试语句
- **禁止** 在 provider 实现里直接读 API key（必须走 `packages/auth`）
- **禁止** 在业务代码里直接用 `undici` / global `fetch`（必须走 `packages/http-kit`）
- **禁止** 在同一个 PR 里跨越多个 §4 边界规则（应拆分）
- **禁止** 在 `provider-kit` / `tool-kit` 里加入除类型定义外的运行时代码（kit 是纯契约）
- **禁止** 在 `Runner` 里直接持有 `ProviderClient`（必须通过 `RouterPolicy`）
- **禁止** 在任何路径（包括 telemetry）添加"默认开启的网络上报"，违者视为安全 breach
- **禁止** 在 `plugin-runtime` 里跑 TS 编译器 / 支持多文件 + `node_modules` 加载（MVP 只吃 bundled 单文件 ESM）
- **禁止** 在 `volund` JSBridge 之外给插件开旁路 API（不允许暴露 `native` / `core` / `runner` / 其它插件对象）；**例外**：`volund.provider.register` 受控开放（仅 `kind:'provider'` 插件注册 ProviderClient，必经 Router，见 spec PLUGIN-PROVIDER-r1）；provider **直调**入口（stream/complete/getCredential）仍禁止
- **禁止** 在 `plugin-runtime` 用 `node:vm` / `worker_threads` 跑插件，或内部直接 `child_process.spawn(node)`。插件宿主**必须**走 `native-bridge.runPlugin()` → `volund-sandbox --run-plugin` 独立子进程（Rust 沙箱一等公民规则，见 AGENT.md §4.7）
- **禁止** 在业务代码里手动生成 sandbox profile（必须通过 `native-bridge` 从 `PermissionSpec` / `manifest.permissions` 单向映射）
- **禁止** 用 `--dangerously-no-sandbox` / `--skip-verify` 而不同时打红条 + `security.event` telemetry
- **禁止** 在 `provider-*` / `router` / `tools` 里直接拼接 system prompt（必须走 `core.PromptComposer`）
- **禁止** 静默继承旧版本插件的权限批准（升级导致 `permissions` 变化必须再次弹窗）
- **禁止** 在 `packages/plugin-sdk` 里加运行时逻辑（只发类型 + `<T>(x: T) => T` 类型收敛 helper）
- **禁止** 在 provider 实现里绕过 verify-first-store-second（`volund login` 必须先调最小验证接口，2xx 才落盘）
- **禁止** 在 `auth` 包里发缺失 §8.4.1 事件的分支代码（每一个 login / getCredential / migration / keychain error 分支都必须发对应事件）
- **禁止** 让 auth 事件 payload 携带任何 raw key / token / passphrase / OAuth code / Authorization header / URL userinfo（必须过 `shared.sanitize()`）
- **禁止** 绕过 `packages/memory-runtime` 直接读写 `~/.volund/memory/` 或 `<cwd>/.volund/memory/`（`storage` / `tools` / provider 均不允许，见 AGENT.md §4.14）
- **禁止** 写入不含合法 frontmatter 的 memory md（缺任一必填字段直接拒绝）
- **禁止** memory md body 超过 `[memory].max_body_lines`（默认 200 行）而不触发 §4.14 的 4 层降级链
- **禁止** 在 memory 中写入 credentials / API key / raw token（`memory.preWrite` 内置 sanitize 兜底）
- **禁止** 在 `provider-*` / `router` / `tools` 里另起 memory 提示词（只允许 `builtin:memory-guide` + `volund.memory.contributePrompt`）
- **禁止** 未声明 `manifest.permissions.memory` 就调用 `volund.memory.*`（bridge 直接 `-32601`）
- **禁止** 在 `packages/core` 之外实现 `@include` 展开逻辑（`prompt-loader.ts` 是唯一实现）
- **禁止** `@include` 引入 `.md` 以外的扩展名（json / toml / 代码文件一律拒绝）
- **禁止** 在工具输出 / 模型消息 / 用户对话文本里做 `@include` 展开（仅限 volund 内部 prompt 装载管线）
- **禁止** `@include` 路径落在 `<cwd>/**` 或 `~/.volund/**` 之外（canonicalize 后判定，symlink 逃逸即拒绝）
- **禁止** 修改 `[memory].max_body_lines` 而不同步更新 `memory-guide` 提示词（会导致模型不自知地反复超限）

### C5. 沟通语气

- 中文交流为主，代码/标识符/commit 用英文
- 简洁直接，不要 hedging（"我建议或许可能..."）
- 报告结果时如实说：失败就说失败，跳过就说跳过

### C6. 设计文档位置

- 设计（spec）: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- 实现计划（plan）: `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md`
- 文档站正式内容: `apps/docs/`

### C7. 治理文件（不可绕过）

- `LICENSE`（Apache-2.0） / `SECURITY.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` 存在于仓库根。
- 提交必须走 DCO：`git commit -s`。
- 破坏性变更需 RFC 流程（`CONTRIBUTING.md` § RFC process），7 天冷静期。
- 触及 CLI 命令树 / 系统提示词 / 权限模型 / 遥测默认 / 治理文件 / **memory 系统 / `@include` 机制** 时，先读 spec §6-§6.5.6 / §6.12 / §11-§14。
