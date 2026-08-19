> ↩ [返回索引 (README)](./README.md) · ← [上一章: §10 里程碑](./10-milestones.md)

---

# L1 Release Checklist · MVP 发版前可勾选清单

> **用途**：把散落在 §3–§14 各章的 **L1 相关强制点 + Definition of Done + CI matrix + 完成闸门** 汇成**单一可勾选清单**，让人（或 AI）在 L1 收尾时不必翻 10+ 个文件拼清单。
>
> **设计依据**：[§10 L1](./10-milestones.md#l1mvp--可用的对话--工具--maclinux-4-target-沙箱底座) 的 14 条交付项 + 各章末"边界与安全清单"中 L1 范围内的条目 + §10「每阶段完成闸门」8 项 + §9.4 CI matrix（L1 子集）。
>
> **与 §12.6b 的关系**：符合「spec 即 AI 可执行契约」——AI 执行 L1 收尾时跑此 checklist 即可确认所有强制点落地。每个条目都标注了**强制方式**（CI 自动 / 单元测试 / 手动 / dog-fooding）。

---

## 使用方法

1. **逐项勾选**：每项确认后打 `[x]`，未完成留 `[ ]`
2. **强制点优先**：标 ⚙️ 的是 CI/测试自动 gate（硬阻塞）；标 🛡️ 的是安全相关（不可妥协）；标 👤 的是手动验证
3. **阻塞 vs 非阻塞**：所有 ⚙️ + 🛡️ 必须 100% 绿才允许 L1 发版；👤 项若有未完成，需在 release notes 显式说明残留风险
4. **完成此 checklist 后**：勾选 §10「每阶段完成闸门」最后一项，方可打 L1 tag

---

## 0. Definition of Done（§10 L1）

> L1 的核心 DoD：**能用 `apollo` 对着 Anthropic 完成一个真实的编码任务（改文件 + 跑测试 + 提 PR），全程权限弹窗可控；mac/linux 4 target 的 escape 测试基础用例全部通过，任何降级都在 UI 显式披露**。
>
> ★ r13-G6 注：「提 PR」经 Bash + `gh` CLI 完成（用户环境需预装；CONTRIBUTING 已列推荐依赖；doctor §11.3.10 检测但不因缺失 fail）。「跑测试」的长命令场景由后台 Bash（`runInBackground` + `ShellOutput`，§4.3.1）支撑。

- [ ] 👤 **真实编码任务跑通**（dog-fooding，闸门第 7 项）：用 apollo 完成 ≥1 个真实编码任务，覆盖「读文件 → 改文件 → 跑测试」全链路
- [ ] 👤 **全程权限弹窗可控**：任务过程中所有副作用操作（Write/Edit/Bash）都走 permission 决策链，无静默放行
- [ ] ⚙️ **mac/linux 4 target escape 测试全通过**：任何降级都在 UI 显式披露（见第 4 节沙箱）

---

## 1. CI 自动门（⚙️ 硬阻塞，§9.4 L1 子集）

L1 CI matrix：`ts` + `license-check` + `native`(4 target) + `sandbox-escape`(4 target)。

- [ ] ⚙️ **ts job 全绿**（3 平台 ubuntu-24.04 / macos-14 / windows-2022）：`pnpm turbo run typecheck test build`
- [ ] ⚙️ **license-check 全绿**：`cargo deny check licenses bans`（拒绝 GPL/AGPL/SSPL/BUSL 进依赖树）+ codex workspace 依赖数量 ≤ 上次 release（只减不增）
- [ ] ⚙️ **native job 全绿（4 target）**：
  - [ ] macos-14 → `aarch64-apple-darwin`（native build）
  - [ ] macos-13 → `x86_64-apple-darwin`（native build）
  - [ ] ubuntu-24.04 → `x86_64-unknown-linux-gnu`（native build）
  - [ ] ubuntu-24.04 → `aarch64-unknown-linux-gnu`（cross build）
  - [ ] macOS 双架构 `lipo -create` → universal2 合并成功
  - [ ] Linux target: `apollo-sandbox --verify-bwrap-digest` 校验 bundled bwrap SHA256 通过
- [ ] ⚙️ **sandbox-escape job 全绿（4 target）**：每 target 跑基础 escape 用例集（复用 codex `sandbox_smoketests.py` + `seatbelt_tests.rs` + `landlock_tests.rs`）；cross target 走 QEMU user-mode，结果标 `partial-verified`
- [ ] ⚙️ **`apollo doctor --strict` 全绿**（mac/linux 4 target 各跑一次，[§11.3.10](./11-cli-commands.md)）：node version / apollo version / native-bridge available / auth / config valid / cwd writable

> **发版硬门**（§9.9 / §10 闸门第 2 项）：以上任一红 → **不允许 release**，GitHub branch protection 强制。

---

## 2. 核心内核（§2 Agent Loop）

### 2.1 事件总线（§2.3）

- [ ] ⚙️ **19 种事件全部实现**（含 `session.resumed` 与 r13-G2 的 `shell.background_started/exited`，[§2.3 表](./02-agent-loop.md#23-事件总线-core)）
- [ ] ⚙️ **`event.id` 用 UUIDv7**（时间前缀 + 单调可排序）
- [ ] ⚙️ **subscriber seen-set 去重**（LRU 上限 10k）+ storage JSONL idempotency key 双层保护
- [ ] ⚙️ **Core 只发不订**（唯一 emitter，ESLint 强制）

### 2.2 Runner 主循环（§2.4）

- [ ] ⚙️ **B1 PromptComposer 注入**：`provider.stream` 的 `system` 字段由 `promptComposer.compose(state, capabilities)` 生成（单元测试）
- [ ] ⚙️ **B2 maxToolLoopsPerTurn**：默认 25，触顶 emit `error.raised{code:'tool_loop_exhausted'}`（单元测试）
- [ ] ⚙️ **B3 abort 传播链完整**：`runner.interrupt() → turnAbort.abort() → provider stream + tool.invoke(abortSignal) → sandbox 子进程 SIGTERM`（集成测试）
- [ ] ⚙️ **B4 stickyProvider 语义**：第一个 `tool_use.start` chunk 抵达即锁定；锁定期内违反切 provider → emit `provider_sticky_violation`（单元测试，消除 REVIEW-r6 P0-2 竞态窗口）

### 2.3 并行 Tool 调用（§2.5）

- [ ] ⚙️ **默认并行**（provider.capabilities.parallelToolCalls ? Infinity : 1）
- [ ] ⚙️ **Permission 内部串行弹窗**（队列，防刷屏，单元测试）
- [ ] ⚙️ **B5 并行语义**：N 个 tool_use 各自独立 preToolUse pipeline；veto 只影响当前 tool_use 不打断其它（集成测试）
- [ ] ⚙️ **单 tool 失败不影响其他**（各自返回 error content）

---

## 3. Provider & Router（§3）

### 3.1 provider-anthropic（L1 唯一 provider）

- [ ] ⚙️ **`provider-kit` 完整契约**：ProviderClient / ProviderRequest / ProviderChunk / ProviderCapabilities / RawMeta（类型 + 单元测试）
- [ ] ⚙️ **Message ↔ Anthropic Messages 双向转换器**（含图像/工具/思考，单元测试）
- [ ] ⚙️ **Stream 帧 → ProviderChunk 归一化**（SSE `content_block_delta` 解析，单元测试）
- [ ] ⚙️ **错误码 → ProviderError**（含 retryable / category，单元测试）
- [ ] ⚙️ **Auth 挂载**：读 `packages/auth` 拿 credential（ESLint no-restricted-imports 禁直读 process.env）
- [ ] ⚙️ **走 http-kit**：禁止 `import { fetch } from 'undici'`（ESLint）
- [ ] ⚙️ **AbortSignal 传递到底层 http**（单元测试：发大请求 abort 检查连接断开）

### 3.2 SingleProviderRouter（L1 唯一 router）

- [ ] ⚙️ **SingleProviderRouter 实现**（`pick` + `onError`，[§3.8.1](./03-provider-router.md#381-singleproviderroutermvp-必备)）
- [ ] ⚙️ **错误时必须决定 retry/fallback/give-up**（不能吞异常，Runner 层强制）
- [ ] ⚙️ **Router 切换 emit `router.switched`**（L1 SingleRouter 不切换，但事件机制须在）

### 3.3 流式中断（§3.9a）

- [ ] ⚙️ **provider 适配器异常终止 emit `message.interrupted`**（不发 `message.stop`，二选一互斥，单元测试模拟 RST/abort/不完整 body）
- [ ] ⚙️ **text 拼接用 streaming `TextDecoder`**（禁逐 chunk `Buffer.toString()`，多字节边界单元测试）
- [ ] ⚙️ **Runner 收到 `message.interrupted` 作废进行中 message**（不落盘，core 集成测试）
- [ ] ⚙️ **UI 收到后标记撤销而非提交**（ui 单元测试）
- [ ] ⚙️ **sticky 期间禁止跨 provider fallback**（单元测试 assert 不调 router.pick）

### 3.4 @ 统一 picker 的 model 分支（§3.9 + §7.5.3，r9/r10 确认 L1 落地）

- [ ] ⚙️ **`@` 触发统一 picker**（alias 置顶 ⭐ + 文件候选 📄 跟后，禁启发式，InputBox 单元测试）
- [ ] ⚙️ **选 alias → model 模式**：剥离 `@<alias>` 前缀传 Runner，`RouterHint.explicitModel`
- [ ] ⚙️ **alias 与文件同名时 alias 优先 + Tab 切 file**

---

## 4. 工具与权限（§4）+ Rust 沙箱（§5）

### 4.1 内置 7 工具（L1: Read/Write/Edit/Bash/Grep/Glob/Todo，§4.3）

- [ ] ⚙️ **7 工具全部实现 + inputSchema (JSON Schema) 校验**（[§4.3 表](./04-tools-permissions.md#43-内置工具清单packages-tools)）
- [ ] ⚙️ **破坏性 tool（Write/Edit/Bash）声明 sandbox 需求**（单元测试）
- [ ] ⚙️ **Tool 抛异常 = bug**（应 catch 内部转 isError，Runner 兜底 + 单元测试）
- [ ] ⚙️ **Tool 禁止 import provider/router/core Runner**（ESLint）
- [ ] ⚙️ **Tool 禁止直接调 native binary，必须走 native-bridge**（ESLint no-restricted-imports）
- [ ] ⚙️ **Tool 输入 schema 验证先于 permission**（失败立即返 isError，不进 tool）
- [ ] ⚙️ **tool_result 文本超长截断**（> 25k tokens 中段截断，[§4.9](./04-tools-permissions.md#49-tool-结果规范化)）
- [ ] ⚙️ **工具注册名前缀约定**（内置占固定名；MCP/插件 `mcp:` / `plugin:`，但 L1 无此两类）

### 4.2 Permission 决策链（§4.4）

- [ ] ⚙️ **8 步决策链完整**（项目黑→全局黑→sessionCache→项目toml→全局toml→auto-allow→dangerous-skip→弹窗，单元测试）
- [ ] ⚙️ **auto-allow 保守规则**（Read/Grep/Glob 在 cwd 内 allow-session；raw Bash 无静默白名单，含 `pwd` / `git status` / `pnpm test` 在内均须显式 grant 或弹窗；无 prompt 时 deny）
- [ ] ⚙️ **弹窗串行**（permission 内部队列一次一个）
- [ ] ⚙️ **`permissionCache` 只在 session 内有效**（SessionState 不持久化它）
- [ ] 🛡️ **`--dangerously-skip-permissions` / `--yolo` 必须打警告日志 + UI 顶栏红条**（apps/cli 强制）

### 4.3 Rust 沙箱（§5，L1 硬约束：mac/linux 4 target）

> **产品硬约束**（不可动摇）：沙箱必须在 mac/linux 4 target 全绿（[SANDBOX-COMPAT-r1 §S1](./SANDBOX-COMPAT-r1.md)）。L1 不允许绕过。

- [ ] ⚙️ **vendor codex 沙箱三件套**（sandboxing + linux-sandbox + windows-sandbox-rs）+ 12 workspace 依赖 crate，跑通 mac/linux 4-target 编译
- [ ] ⚙️ **`apollo-sandbox exec` + `--probe` 四挡**（Full/Partial/Weak/None）
- [ ] ⚙️ **macOS Backend 完整**（codex `seatbelt.rs`，T1 aarch64 / T2 x86_64）
- [ ] ⚙️ **Linux Backend：bundled bwrap 默认 + landlock fallback**（T3/T4 glibc）
- [ ] ⚙️ **`apollo-search` + `apollo-fs` 独立二进制 worker**（r9 架构变更，原 napi addon 作废）
- [ ] ⚙️ **`native-bridge` 二进制路径发现 + WorkerPool**（spawn/握手/重启/idle 回收）+ tier 探测 + 冻结缓存 + JS fallback（search/fs）
- [ ] ⚙️ **bundled bwrap SHA256 校验机制落地**
- [ ] 🛡️ **`--dangerous-no-sandbox` 必须打日志 + UI 红条 + telemetry `security.event` + 每次危险操作二次弹窗**（apps/cli + permission 强制）
- [ ] 🛡️ **sandbox profile 禁止放宽 PermissionSpec 声明的权限**（crates/apollo-sandbox 单元测试）
- [ ] 🛡️ **sbpl 路径转义 / seccomp 架构分表 强制单元测试覆盖**
- [ ] ⚙️ **Rust crate 禁止发布 npm**（pnpm workspace 配置）
- [ ] ⚙️ **`apollo-search` 结果尊重 `.gitignore` / `.apolloignore`**（单元测试）
- [ ] 🛡️ **codex fork 保留原 LICENSE + NOTICE**（Apache-2.0，OpenAI 归属，代码审查 + 发布前检查）
- [ ] 🛡️ **codex workspace 依赖只减不增**（CI `cargo deny` 禁止新增 codex-* 依赖）
- [ ] ⚙️ **JS 侧只有 `packages/native-bridge` 可 require platform 包**（ESLint no-restricted-imports）
- [ ] ⚙️ **sandbox binary 是独立进程，不 dlopen 进 Node**（crates/apollo-sandbox 是 bin 不是 lib）
- [ ] ⚙️ **每 target 跑真机 escape 逃逸测试**（无 runner 时明示 `unverified` 不发 stable）

### 4.4 Sandbox Tier 披露（§5.5 / §14.3b）

- [ ] 👤 **Onboarding 首屏沙箱 Tier disclosure**（mac/linux 4 target；Windows/musl L2 起接入）
- [ ] ⚙️ **`sandbox.tier` telemetry 事件启动即发**（含 platform/arch/libc/os_version/kernel/tier/features，本地 sink）
- [ ] ⚙️ **tier 冻结**（native-bridge 启动探测一次，session 内不变；变化需重启）

---

## 5. 会话与配置存储（§8）

### 5.1 Session JSONL（§8.2 + §8.2b）

- [ ] ⚙️ **JSONL append-only + fsync**（崩溃安全，storage 单元测试）
- [ ] ⚙️ **每行首字段 `v: <schema_version>`**（当前 1，REVIEW-r6 P1-3）
- [ ] ⚙️ **`id` 是 UUIDv7**（幂等 key）
- [ ] ⚙️ **stream.delta 不写盘**（只写 stream.completed 含完整 assistant message）
- [ ] ⚙️ **附件二进制不进 JSONL**（存独立文件按 hash 索引）
- [ ] ⚙️ **JSONL 分段加载 + 行级索引**（§8.2b，lazy build，sourceHash 失效判断，storage 单元测试）
- [ ] ⚙️ **resume `tailTurns: 20`**（不全量读，<2s 恢复 50MB session）
- [ ] ⚙️ **索引损坏 fallback 全量顺序读**（不阻断 resume）
- [ ] ⚙️ **Replay 只重建 SessionState**（不复现流式动画、不重放 hook/tool/provider）
- [ ] ⚙️ **resume emit `session.resumed`**（替代 session.started）
- [ ] ⚙️ **resume 后 turn.status 非 done/aborted/error → 强制 mark aborted**

### 5.2 Config 分层（§8.3）+ 信任门（§8.3.1）

- [ ] ⚙️ **config.toml 分层**（内置<全局<项目<env<flag，zod schema 启动校验失败不启动）
- [ ] 🛡️ **项目级 config / mcp.toml 首次加载走信任门**（§8.3.1：首次弹信任确认 + config_hash 变化重弹，单元测试）
- [ ] 🛡️ **非交互模式（CI / --no-tui）项目级 config 默认 deny**（需 `--trust-project-config`，单元测试）
- [ ] 🛡️ **数据流向 key 禁止项目级覆盖**（provider.*.baseUrl / telemetry sink+endpoint / router / auth / *_api_key 模式，设了忽略 + warning，单元测试）
- [ ] ⚙️ **`--cwd <path>` 必须 realpath 归一化 + 拒绝根/home/敏感前缀**（W6，[§11.6](./11-cli-commands.md)，apps/cli + path-guard.ts）

### 5.3 Credentials（§8.4）

- [ ] ⚙️ **三层 fallback**：OS keychain → 加密文件（Argon2id KDF，§8.4.0a）→ env
- [ ] 🛡️ **Layer 2 加密文件 KDF 必须 Argon2id**（m=64MB, t=3, p=2；禁 PBKDF2/SHA 直接派生）
- [ ] 🛡️ **Layer 2 在线 brute-force 防护**（3 次起指数退避 + 20 次锁 24h，§8.4.0a）
- [ ] 🛡️ **credentials 禁止明文写任何文件**（除 credentials.enc，ESLint + 单元测试扫 sink）
- [ ] 🛡️ **login verify-first-save-second**：先调 provider verify 接口（如 /v1/models）2xx 才落盘
- [ ] 🛡️ **login 禁止 flag 明文传 key 到 shell history**（推荐 `--api-key-stdin`，CLI 输出警告）
- [ ] 🛡️ **auth 每个登录/getCredential/migration 分支发 §8.4.1 事件**（单元测试 + telemetry sink assertion）
- [ ] 🛡️ **auth 事件 payload 过 `shared.sanitize()`**（禁 raw key/token 入日志，ESLint sink 白名单）

---

## 6. 上下文管理（§8b，L1: SlidingWindowPolicy）

> L1 唯一策略 = SlidingWindowPolicy（[§8b.4](./08b-context-policy.md#84-slidingwindowpolicyl1-唯一落地)）。

- [ ] ⚙️ **SlidingWindowPolicy 完整**：shouldCompact + buildPrompt + compact（按 budget 滑窗，单元测试）
- [ ] ⚙️ **token 估算三层**：native countTokens（优先）→ gpt-tokenizer（fallback）→ 字符近似（兜底）
- [ ] ⚙️ **budget 预扣**：maxContextTokens - systemTokens - toolSchemaTokens - reservedOutput（单元测试）
- [ ] ⚙️ **tool_use ↔ tool_result 配对不可拆**（单元测试构造含 tool 配对的 messages）
- [ ] ⚙️ **compact 不丢失 turn 边界**（不留 user message 却丢 assistant 响应，单元测试）
- [ ] ⚙️ **preCompact/postCompact 拦截型 hooks**（preCompact veto 必须尊重，context + hooks 集成测试）
- [ ] ⚙️ **token 估算缓存 key 含 model**（不跨 model 共享缓存，单元测试）
- [ ] ⚙️ **compact 是异步的**（Runner await，turn 状态 = 'compacting'，core 集成测试）

---

## 7. PromptComposer（§6.5，L1 子集）

> L1 无 Skill/Memory/Plugin，所以 composer 只有 builtin + project(AGENT.md) + user(PROMPT.md) 三个 fragment 来源。

- [ ] ⚙️ **PromptComposer 接口 + 内置实现**（register / compose / invalidate，[§6.5](./06b-prompt-composer.md#65--系统提示词的组合模型promptcomposer)）
- [ ] ⚙️ **priority 降序排序**（同优先级按 id 稳定，单元测试）
- [ ] ⚙️ **拼接用 `\n\n---\n\n` + `<!-- source: xxx -->` 注释**（§6.5.5）
- [ ] ⚙️ **builtin fragment priority=1000**（[§6.5.1 内置 prompt draft](./06b-prompt-composer.md#651-内置-system-prompt-具体-draft)）
- [ ] ⚙️ **AGENT.md 语义规则**（cwd 向上遍历 ≤8 级不跨 home；priority 600 - 10*level 下限 500；CLAUDE.md fallback 复用同槽位，[§6.5.4](./06b-prompt-composer.md#654-agentmd-语义规则)）

### 7.1 @include 机制（§6.5.6）

- [ ] 🛡️ **@include 仅在 apollo 提示词管线展开**（Read/Grep/Edit 不展开，PromptLoader 与 Read 是不同代码路径，单元测试）
- [ ] 🛡️ **展开路径落在 workspace 或 ~/.apollo 双白名单内**（canonicalize 检查，单元测试）
- [ ] 🛡️ **原子 open + fstat**（禁 stat-then-open 防 symlink TOCTOU，§6.5.6，单元测试含 symlink 竞态用例）
- [ ] 🛡️ **敏感文件名黑名单**（credentials* / ~/.ssh / .env / id_* / *.pem，单元测试）
- [ ] ⚙️ **递归深度 8 / 展开次数 64 / 循环检测**（单元测试）
- [ ] ⚙️ **每次展开过 permission.fs.read**（集成测试）
- [ ] ⚙️ **非 md 文件拒绝**（单元测试）
- [ ] ⚙️ **出错留占位注释而非 abort compose**（集成测试）

### 7.2 非可信内容包裹（§6.5.0a）

- [ ] 🛡️ **所有非可信来源进 provider 包 `<untrusted source="...">`**（core MessageBuilder 单元测试枚举每种来源）
- [ ] 🛡️ **wrapper source 可追溯到具体来源**（tool 名 / server 名 / 路径）
- [ ] 🛡️ **用户直接输入禁止被误包**（集成测试）
- [ ] 🛡️ **`<untrusted>` 标签禁止被工具结果内容伪造**（注入含 `</untrusted>` 的工具结果，assert 不破坏包裹）

---

## 8. 终端 UI（§7）

### 8.1 Ink 组件树（§7.2）

- [ ] ⚙️ **UI 只订阅 core 事件，只调 Runner 公开 API**（不直接改 SessionState，code review）
- [ ] ⚙️ **stream.delta UI 侧自 throttle 30fps**（上游不背压，[§7.3](./07-terminal-ui.md#73-流式背压策略)）
- [ ] ⚙️ **UI 禁止直接调 ProviderClient / ToolRegistry**（ESLint）

### 8.2 权限弹窗 + InputBox

- [ ] ⚙️ **permission.setPromptHandler 反向注入**（ui 提供，permission 无 import ui）
- [ ] ⚙️ **slash 命令补全**（`/` 前缀 popup）
- [ ] ⚙️ **`@` 统一 picker**（见 §3.4）
- [ ] 🛡️ **InputBox 历史禁止明文存 API key/token**（脱敏，history writer 白名单）

### 8.3 信号处理（§7.3a）

- [ ] ⚙️ **Ctrl+C (SIGINT)**：runner.interrupt() → turnAbort.abort()，session 存活
- [ ] ⚙️ **SIGTERM / SIGHUP**：graceful shutdown → session.ended → flush storage → 退出
- [ ] 👤 **Ctrl+Z (SIGTSTP) 已知限制文档化**（v1 不特殊处理，建议用户避免 turn 进行中挂起）

---

## 9. 构建 / 分发（§9）

- [ ] ⚙️ **pnpm workspace + catalog 统一版本**（[§9.2](./09-build-ci-dist.md#92-pnpm-workspace)）
- [ ] ⚙️ **turbo pipeline** 依赖顺序：kits → core → router/providers/tools → apps（[§9.3](./09-build-ci-dist.md#93-turbo-pipeline)）
- [ ] ⚙️ **rolldown 打 apps/cli 单 bin**（`dist/apollo.js` + shebang，package.json `"bin": {"apollo": "dist/apollo.js"}`）
- [ ] ⚙️ **changesets 发版**（L1: 12 平台包 = 4 target × 3 crate + apollo-code + fs-common）
- [ ] ⚙️ **平台包 optionalDependencies 挂载**（native-bridge 声明 12 包，[§1.6](./01-repo-layout.md#16-rust-原生分发模型业界标准-pattern)）
- [ ] ⚙️ **`pnpm-lock.yaml` CI 校验一致**（--frozen-lockfile）
- [ ] ⚙️ **依赖升级走 Renovate PR + CI**（禁手动改 lock）

---

## 10. CLI 命令（§11，L1 子集）

L1 必须的命令：`chat` / `login` / `logout` / `config` / `history list-show` / `doctor`（L1 项）/ `hook list`（builtin only）/ `version` / `help` + 交互 REPL 基础 slash。

- [ ] ⚙️ **citty parser + 嵌套子命令 + 自动 help**
- [ ] ⚙️ **TTY 检测** → 决定进 Ink（交互）还是 flag/pipe 模式
- [ ] ⚙️ **`--no-tui` / `--json` / `--no-color` 支持**
- [ ] 🛡️ **`--dangerously-*` / `--yolo` 必须发 telemetry event 一次**（apps/cli 强制）
- [ ] 🛡️ **项目级 config 非交互模式默认不加载**（需 `--trust-project-config`，单元测试）
- [ ] ⚙️ **CLI 返回码约定**：0 成功 / 1 用户错误 / 2 系统错误 / 130 Ctrl+C
- [ ] ⚙️ **交互 slash 命令与 CLI 子命令名字语义一致**（单元测试）

---

## 11. Onboarding（§14，L1）

- [ ] 👤 **完整 3 步 onboarding**（provider 选 → API key 输入验证 → 首个任务，[§14.2](./14-onboarding.md#12-首次运行流程)）
- [ ] 👤 **首屏隐私声明**（写任何 config 前；本地 telemetry / 无自动上报）
- [ ] 👤 **沙箱 Tier 披露**（见 §4.4，config 写入前）
- [ ] ⚙️ **API key 输入 mask**（不回显）
- [ ] ⚙️ **API key 先验证再存**（verify-first-save-second）
- [ ] ⚙️ **存储位置降级路径明示**（keychain 不可用 → 加密文件 / env）
- [ ] ⚙️ **`--strict-sandbox` 遇 Partial/Weak exit(3)**（禁降级启动）
- [ ] 🛡️ **`--dangerous-no-sandbox` / None Tier 要求用户显式输入确认句**（"I understand the risk"，禁静默）
- [ ] ⚙️ **非交互模式禁弹 TUI**（改报错；Tier < 期望值时退出码 3）
- [ ] ⚙️ **首次运行不写任何自动 telemetry 到远端**（本地仍写）
- [ ] 👤 **项目首次进入检测**（提示但不自动 gen AGENT.md，L1 只 "Just proceed"）

---

## 12. 完成闸门（§10「每阶段完成闸门」8 项）

- [ ] ⚙️ **闸门 1**：所有 §4 边界规则未被违反（CI + ESLint 强制）
- [ ] ⚙️ **闸门 2**：全 CI matrix 通过（见第 1 节，L1: 4 native + 4 escape 全绿）
- [ ] 👤 **闸门 3**：所有 Definition of Done 手动验证（见第 0 节）
- [ ] 👤 **闸门 4**：AGENT.md / CLAUDE.md 同步更新
- [ ] ⚙️ **闸门 5**：变更走 changeset，发到 npm（L1: 12 平台包）
- [ ] 👤 **闸门 6**：apps/docs 该阶段新能力文档更新
- [ ] 👤 **闸门 7**：至少一次真实使用（dog-fooding，用 apollo 开发 apollo）
- [ ] 👤 **闸门 8**：release notes 明确标注每 target 的 Sandbox Tier + escape.pass_ratio（任何降级须有 issue 追踪）

---

## 签收（Sign-off）

L1 release 前由 **BDFL（人，[§12.7](./12-open-governance.md#127-治理决策模型)）** 确认：

- [ ] 所有 ⚙️ + 🛡️ 条目 100% 绿
- [ ] 所有 👤 条目已完成，或残留项已在 release notes 显式说明
- [ ] 上述 §10 完成闸门 8 项全部勾选
- [ ] 安全相关决策（§12.6b 人在环检查点）已人工审批

**签收人**：__________ **日期**：__________ **apollo 版本**：v0.1.0

---

## 参考（强制点来源章节）

| 本 checklist 节 | 强制点来源 |
|---|---|
| §1 CI 自动门 | [§9.4 CI Matrix](./09-build-ci-dist.md#94-ci-matrix) + [§10 闸门](./10-milestones.md#每阶段完成闸门) |
| §2 核心内核 | [§2.3–§2.5](./02-agent-loop.md) + §2 边界（隐含在各小节强制点） |
| §3 Provider & Router | [§3.10 边界与安全清单](./03-provider-router.md#310-边界与安全清单) + §3.11 里程碑 |
| §4 工具/权限/沙箱 | [§4.11 边界](./04-tools-permissions.md#411-边界与安全清单) + [§5.10 边界](./05-rust-sidecar.md#510-边界与安全清单) + §5.11 里程碑 |
| §5 会话与配置 | [§8.8 边界](./08-session-config.md#88-边界与安全清单) + §8.9 里程碑 |
| §6 上下文管理 | [§8b.9 边界](./08b-context-policy.md#8b9-边界与安全清单) + §8b.11 里程碑 |
| §7 PromptComposer | [§6.5.6 @include 边界](./06b-prompt-composer.md#656-include-机制) + [§6.5.0a untrusted 边界](./06b-prompt-composer.md#650a-非可信内容包裹untrusted-content-wrapping) |
| §8 终端 UI | [§7.7 边界](./07-terminal-ui.md#77-边界与安全清单) + §7.8 里程碑 |
| §9 构建/分发 | [§9.8 边界](./09-build-ci-dist.md#98-边界与安全清单) + §9.9 里程碑 |
| §10 CLI 命令 | [§11.6 边界](./11-cli-commands.md#116-边界与安全清单) + §11.7 里程碑 |
| §11 Onboarding | [§14.7 边界](./14-onboarding.md#147-边界与安全清单) + §14.8 里程碑 |

> 若本 checklist 与各章 spec 冲突，以各章 spec 为准；本 checklist 只是 L1 范围内的**汇总视图**。任何 spec 更新涉及 L1 强制点时，应同步更新本文件。
