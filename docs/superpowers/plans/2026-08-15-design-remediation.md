# 设计一致性整改方案（2026-08-15）

> **状态**：待 BDFL 批准
> **输入**：[REVIEW-r11 文档正确性审计](../specs/2026-07-31-volund-code-design/REVIEW-r11.md) + 三子系统实现评审（插件 / 记忆 / TUI，2026-08-15，基准 main `5fa00a7`）
> **性质**：本文档是整改的**单一执行计划**。每项差异只有两个合法出口——**A. 改代码追设计**，或 **B. 改文档认现实**；禁止保留"文档空转"的第三态。每项标注出口与验收标准。

---

## 0. 原则与顺序

1. **治理文档止血优先于一切**：AGENT.md/CLAUDE.md 是 AI 代理的"宪法"，其中 24 条过时/幻影条目（REVIEW-r11 第三部分）每分钟都在误导开发。先让文档停止说谎，再谈补齐。
2. **改文档 ≠ 降级**：把未实现能力标注为 `未实现`/`planned` 是诚实化，不是放弃；反过来，把 L1 硬承诺（如 @ picker）从 spec 删除需要 BDFL 显式决策，本方案默认**代码追设计**。
3. **每完成一项，同步更新 16-capability-traceability**（它是声明的 status authority）。
4. 工作包之间除标注外无强依赖；WP1/WP2 可与 WP4 并行。

## 工作包总览

| WP | 主题 | 类型 | 优先级 | 规模 |
|---|---|---|---|---|
| WP1 | 治理文档止血（AGENT.md / CLAUDE.md / CONTRIBUTING.md） | 纯文档 | **P0** | 小（半天） |
| WP2 | spec 卷回收（06a/06b/06c/07/11/15/README/PLUGIN-PROVIDER-r1） | 纯文档 | **P0** | 中（1-2 天） |
| WP3 | 状态权威刷新 + 防复发机制 | 文档+脚本 | P1 | 小 |
| WP4 | 代码整改——违反硬约束 / 直接伤害用户 | 代码 | **P0** | 中 |
| WP5 | 代码整改——能力补齐 / 决策类欠账 | 代码 | P1 | 大 |
| WP6 | 长尾清理 | 代码 | P2 | 持续 |

---

## WP1 · 治理文档止血（P0，纯文档）

### WP1.1 AGENT.md 逐条修订

| 位置 | 现状 | 改为 |
|---|---|---|
| §4.1 依赖图 L60/65/68 | `memory-runtime`、`hooks`、`http-kit` 幻影包 | 删除或标注 `[planned]`；memory 实现归入 `storage` |
| L13 / CLAUDE.md:39 | 原语 `runPlugin` | `startPluginHost()`（`native-bridge/src/sandbox.ts:70`） |
| L186-190 | "单文件 index.js bundle"；`runPlugin()` | 保留意图但改述：单入口必须匹配 `manifest.main`（多文件目录当前可装载——若要收紧见 REM-16）；API 名更正 |
| L193 | "AST 静态检查保留" | 改为"未实现；隔离靠 Rust 沙箱 + bridge 白名单 + manifest 批准三层" |
| L194 | `-32601 Method not found` | `PluginError('plugin_rpc_method_denied')`（稳定 code，刻意不用 -32601 防泄露） |
| L195 | `plugins.enabled.toml` | `~/.volund/plugins/plugins.json`（`plugin-runtime/src/index.ts:365-373`） |
| L207-211 | `volund.provider.register` "唯一入口…受控开放" | 如实：主进程 `registerProviderPlugin` 已实现未接线；bridge 未暴露（联动 REM-11 决策） |
| L214 | 延迟卸载/sticky 锁 | 如实：当前 disable/uninstall 立即 deactivate（`index.ts:883-889`） |
| L218 | bridge 超时 5s / 心跳 60s | 10s（`plugin_host.mjs:28-31`）/ 5s 发-30s 收（`plugin_host.mjs:14-16`） |
| L225-229 | plugin 默认 priority 50/60 槽 | 如实：无默认槽；priority 由 fragment 自带，区间 -100~100（联动 REM-3） |
| L235-237 | plugin-sdk 零依赖/`defineHook`/`defineCommand` | 如实：依赖 provider-kit（type）；仅 `definePlugin/defineTool` |
| **§4.14 全节（L267-283）** | md/frontmatter/200 行/四层降级/`[memory]` 配置/`volund.memory.recall`/`contributePrompt`/`-32601` | **按 ADR-0010/0011 重写**：JSON 快照 `records.json`；scope=workspace/project/session；64KiB + secret/Unicode/id 守卫（不可禁用）；工具 `Memory.create/get/list/update/delete/pin/unpin`；`permissions.memory = {read: scope[], write, search, export}`；无 `[memory]` 配置段（默认值硬编码，联动 REM-17） |
| §4.15 L288 | "`packages/core/src/prompt-loader.ts` 是唯一实现" | `packages/storage/src/index.ts:105`（`PromptLoader`） |
| L298 | `prompt.include.failed` 事件 | 未实现，删除或标注 |
| L299 | `volund debug prompt` | 命令不存在，删除或标注 `[planned]` |

### WP1.2 CLAUDE.md 逐条修订

- **删除 C4 第 90-100 行对 §4.14/§4.15 的复述**，恢复"引用 AGENT.md 不重复"的自身约定（这是单一事实源裂开的根源）；保留索引行但更新摘要关键词。
- C2 L52：`volund-search` 不在 builtin 工具集（`tools/src/index.ts:482-494`）——改为"构建搜索类功能时优先复用 `native-bridge.search` 能力"，或走 REM-18 把工具接进来后再保留现文案。
- C2 L54 + CONTRIBUTING.md:60：`pnpm build:native` 幻影命令——先确认真实原生构建入口（root `build` 经 turbo 不含 Rust；standalone 构建是否触发 cargo 需核实），然后三处（CLAUDE/CONTRIBUTING/root scripts 二选一：改文案或补 script）统一。
- L27 索引摘要"存储/frontmatter/200 行/权限门/唯一召回路径"→ 按 WP1.1 §4.14 新摘要更新。

**WP1 验收**：对 AGENT.md/CLAUDE.md/CONTRIBUTING.md 中所有 `packages/*` 引用、`pnpm <script>`、`<配置键>`、`<错误码>`、`<API 名>` 做一次 grep 交叉核验（可手工，可并入 REM-19 脚本），零幻影引用。

---

## WP2 · spec 卷回收（P0，纯文档）

| 卷 | 处置 | 要点 |
|---|---|---|
| **README.md** | 更新 | 状态行 "brainstorming" → 如实状态 + 日期；TL;DR 修 "MVP 范围 L4" 与目录表 R0→R6 的矛盾；行数标注刷新；附属文档表追加 REVIEW-r11 与本方案 |
| **06c-memory-system.md** | 整体标注 superseded | 卷首加醒目标记："本卷为历史设计，已被 [ADR-0010](../../../rfcs/0010-memory-core-runtime.md)/[0011](../../../rfcs/0011-memory-cli-prompt-provider.md) 取代"+ 一段"现状摘要"（JSON 快照/scope 模型/工具名/64KiB/无配置段/pinned untrusted wrapper）；正文保留供考古。修正 §6.12.2a 与 §6.12.10 的内部矛盾陈述 |
| **06a-plugins-core.md** | 增补实现状态 | §6.4.1 API 表面逐命名空间标注（已实现 / no-op / 未接线 / 未实现——依据 REVIEW-r11 2.2 表）；§6.4.3 出站事件背压标注"未实现（r6 P0-4 契约待落地）"；错误码/plugins.json/超时数值对齐实现；静态扫描段落与实现一致化 |
| **06b-prompt-composer.md** | 修订 | priority 表 60/50 槽标注未实现（联动 REM-3）；hook priority 分域 → 二选一（建议 **B：改 spec 认可统一 -100~100**，分域复杂度收益低）；超时/心跳数值对齐 |
| **07-terminal-ui.md** | 增补实现状态 | L1 验收清单旁标注当前未达项（Ctrl+C 语义/多行 fallback/@ picker/键位）——**不删除要求**（除 BDFL 决策降级）；补两处 spec 盲点为正式要求：delta 事件不得各自触发 setState；长会话滚动策略（Static 或等价）；NDJSON 真流式 |
| **PLUGIN-PROVIDER-r1.md** | 增补状态 | §P12 里程碑改述："主进程机制已实现（manifest/signing/header/registry/禁 default），bridge 暴露与 CLI 装配未接线"；联动 REM-11 决策后再定终稿 |
| **11-cli-commands.md** | 对齐现实 | plugin install 三形态标注仅本地目录（联动 REM-20）；memory 子命令表替换为实际 11 个；`config/history/model/skill/completion` 标注 `[planned]`；slash `/context` `/compact` `/model` 标注桩状态 |
| **15-self-evolution.md** | 修订 | `scope:'tuning'` → `provenance.source='evolution'`；补"observe 未接线，闭环未闭合"现状；确认阈值 25% vs 30% 二选一（建议改文档认 0.25，或改代码为 0.30——联动 REM-12）；enable/disable CLI 标注 `[planned]` |
| **10-milestones.md** | 微调 | 保留现版；加一行说明 16 卷刷新节奏（联动 WP3） |

**WP2 验收**：任一卷内不再存在"把未实现能力写成既定事实"的段落；06c 顶部 superseded 标记可被新读者 5 秒内识别。

---

## WP3 · 状态权威刷新 + 防复发（P1）

1. **16-capability-traceability.md 刷新**：至少修正 REVIEW-r11 2.8 列出的 3 处 memory 误判；建议把"刷新"从手工快照改为与发版节奏绑定的例行项。
2. **流程约定**（写入 spec README"修改约定"节）：ADR 状态变更为 Accepted 的 PR **必须**同时回收对应 spec 卷（加 superseded/实现状态标注），否则不得合并——本轮 memory 的三层分裂正是缺这条纪律的直接后果。
3. **REM-19 幻影引用检查脚本**（新 `scripts/verify-docs-references.mjs`，挂进现有 verify 体系）：扫描治理文档与 spec 中的 `packages/<name>`、`pnpm <script>`、`~/.volund/<path>` 引用，校验其真实存在；先以 warn 模式上线，存量清零后转 enforce。

---

## WP4 · 代码整改——违反硬约束 / 直接伤害用户（P0）

| # | 问题 | 证据 | 处置 | 验收 |
|---|---|---|---|---|
| REM-1 | TUI 内 Ctrl+C = 退出整个会话（丢工作）；无 interrupt 通道 | `ui/src/InputBox.tsx:73-76`；`InteractiveAppOptions` 无 interrupt；runtime 的 `interrupt()` 只有非 TUI SIGINT 路径可达 | `InteractiveAppOptions` 增加 `interrupt()` 注入；InputBox ctrl+c → turn 进行中调 interrupt、空闲时维持二次退出语义 | 集成测试：turn 中 Ctrl+C 后 session 存活且可继续输入；`/exit` 才退出 |
| REM-2 | 每 delta 一次 setState，33ms 节流被架空 | `ui/src/app.tsx:177` | status 更新移出 delta 分支或并入 buffer flush 回调 | 压测：100Hz delta 下 re-render 次数 ≈ 30fps |
| REM-3 | 插件 prompt 片段在生产 CLI 直接抛 `plugin_prompt_registration_not_supported`（06a §6.4.1 核心能力；PromptComposer 本身支持 register） | `apps/cli/src/runtime.ts:1399` | 接线 prompt.contribute → PromptComposer（带 plugin priority 区间与 dispose）；同时定夺 60/50 槽位去留（建议实现固定槽，消除与 fragment 自带 priority 的二义） | e2e：插件贡献 fragment 出现在 system prompt；deactivate 后消失 |
| REM-4 | hooks.kv 命名空间隔离未接线，恒 `${plugin}:activation`，跨 tool_use 共享（r9 设计目标 parallelInvoke 防竞态失效） | `plugin-runtime/src/index.ts:849,1163`；`runHooks` 的 `options.toolUseId` 从未传入 `hookKv` | 把 toolUseId（及事件维度）接入 hookKv；不清理策略按设计（deactivate 清理） | 单测：两个 tool_use 的 kv 互不可见（现有测试已写 API 形状，补生产路径断言） |
| REM-5 | `preToolUse`/`postToolUse` 从未派发——插件 veto（06a 招牌示例）不可用；唯一接线的 hook 是 memory.* | 类型在 `plugin-sdk/src/index.ts:8-9`；全仓库无 `runHooks('preToolUse'/'postToolUse')` 调用点 | 在 tools 执行路径（`tools/src/index.ts` invoke 链）接线 pre/postToolUse pipeline（veto 短路已实现，复用 `runHooks`） | e2e 复刻 06a §6.4.2 示例：veto `rm -rf` 生效 |
| REM-6 | bridge 假实现收口：`ui`/`http` 抛错、`storage` 内存 Map 不落 dataDir、`config` 恒 undefined——SDK 类型却在承诺它们 | `apps/cli/src/runtime.ts:1471-1497` | ① storage 落盘到插件 dataDir（原子写）；② ui 非交互语义定型：非 TTY/`--json` 下 `confirm` → 默认 deny（fail-closed），并把该语义补进 06a（设计缺口）；③ http 经既有 net 白名单接 http 通道；④ config 读 manifest.config default 合成。**未接线前**，SDK 类型加 `@deprecated not-yet-wired` 标注 | e2e：插件 storage 重启后可读；非交互 confirm 返回 false |
| REM-7 | `--json --yolo` 把 ANSI 红条写进 NDJSON stdout | `apps/cli/src/cli.ts:554-555`（只排除 shouldUseTui 未排除 jsonMode） | banner 输出条件加 `!jsonMode`（走 stderr 或禁用） | 测试：`--json --yolo` 输出可整体 JSON.parse 每行 |

---

## WP5 · 代码整改——能力补齐 / 决策类（P1）

| # | 问题 | 证据 | 处置（含推荐） | 验收 |
|---|---|---|---|---|
| REM-8 | 模型无 recall 工具——spec L3 核心能力（主动召回）只给了 CLI/TUI/插件，模型只能 `Memory.list` 翻页 | `apps/cli/src/memory-tools.ts`（七工具无 recall）；recall service 已存在 | **A（推荐）**：新增 readonly `Memory.recall(query, scope?, tags?, topk?)`，复用 `MemoryRecallService`；readonly 工具并入 auto-allow 白名单（spec §6.12.2a 本就要求）。B：明确 list-only 并改 guide | 模型经 recall 拿到 snippet 且结果包 untrusted wrapper |
| REM-9 | import 档案可携带 `pinned:true` 直达 system prompt，注入块不标来源 | `storage/src/memory-transfer.ts:147,190,199`；`memory-prompt-provider.ts:128-131` | 导入内容默认降为非 pinned（`--allow-pinned` 显式 opt-in）；注入块属性补 `source`（user/agent/evolution/import） | 单测：import 后默认无自动注入；`--allow-pinned` 时注入块含 `source="import"` |
| REM-10 | 索引锁不查进程存活：崩溃后自动 reindex 永久失败，需手动 `--force`；与事实库锁语义不一致 | `storage/src/memory-index.ts:441` vs `memory-runtime.ts:826-836` | 索引锁补 pid 存活检测 + 陈旧接管（对齐事实库锁） | 单测：杀死持锁进程后 start() 自动恢复 |
| REM-11 | provider 插件链路半成品：主进程机制完好但 bridge 未暴露、CLI 未装配、零调用方 | `plugin-runtime/src/index.ts:972-1022`（孤立导出）；`:590-596` 自认 unsupported | **A（推荐）**：接线——bridge 暴露 `provider.register`（kind 门控已在 manifest 校验）+ CLI 装配 `registerProviderPlugin` + Router 显式配置启用。B：文档降级（WP2 已兜底） | e2e：header-template 型 provider 插件经 Router 完成一次 stream |
| REM-12 | evolution `observe()` 零调用——闭环未闭合，"自调优"实际静止；确认阈值 0.25≠文档 30% | `core/src/evolution-engine.ts`（observe 无调用方，主审复核）；`:97` | 接线最小信号源（context compaction 前后 token 命中率等已可观测指标）→ observe → propose；阈值二选一对齐 | 长会话集成测试：引擎产生至少一次 proposal 且 audit.jsonl 可追溯；恶化路径回滚 |
| REM-13 | `@` 统一 picker（r9 决策、L1 必交付）纯函数未接线 | `ui/src/index.ts:320-360` 仅测试消费；InputBox 无 `@` 逻辑 | InputBox 接线统一 picker（alias 置顶+文件候选+`@!`/`@@` 前缀+Tab 切换） | 手工验收按 07 §7.5.3 三场景；单测沿用现有纯函数 |
| REM-14 | 多行输入 fallback 缺失（Shift+Enter 多数终端不识别） | `ui/src/InputBox.tsx:103` | Esc+Enter / Alt+Enter 至少其一 | 手工验收矩阵（tmux/WezTerm/iTerm2） |
| REM-15 | 权限弹窗键位 a/s/d ≠ 设计 y/n/s/f，四档缺 forever/project | `ui/src/PermissionPromptStack.tsx:61-65` | 对齐 spec 四档（这次/会话/项目/永久）+ forever 持久化进 permission 规则存储；若 forever 档暂不做，改 spec 收敛为三档（BDFL 决策） | 键位测试 + forever 决策跨 session 生效 |

---

## WP6 · 长尾清理（P2，持续）

- REM-16 插件"单文件 bundle"约束收紧或文档认现实（当前多文件目录可装载，与 `verifyBundle` 的多文件 integrity 设计并存）。
- REM-17 `[memory]` 配置段：实现 8 个配置项的最小集（maxLines/maxTokens/recall_topk）或 spec 删除。
- REM-18 `volund-search` 接为 builtin 工具（兑现 CLAUDE.md C2 文案）或改文案。
- REM-19 幻影引用检查脚本（见 WP3.3）。
- REM-20 plugin install 的 npm/github 形态与 integrity digest 接入（registry 客户端已写好无调用方）；已批准插件本地篡改防线：把代码 digest 纳入审批记录。
- REM-21 TUI 长会话滚动区（Ink Static 或等价）替换 `slice(-16)` 截断；NDJSON 真流式（`bin.ts:24`）；退出路径 provider dispose / native teardown。
- REM-22 memory 写放大（单文件全量重写）与 session scope GC；死代码 `ScopedMemoryStore` 移除。
- REM-23 出站事件推送 + 背压（r6 P0-4 全套契约）——插件事件订阅从 no-op 变真；规模大，单独立项。
- REM-24 架构守卫测试补盲区："ui 不 import provider/tool-kit"、"core 不 import ink"。
- REM-25 "500 calls/turn" 语义裁定（两路核查结论不一致：turn 维度疑似未接线，实际为进程级 500）——以专项测试定案后改代码或改文档。

## 执行顺序

```
WP1（半天）──┬─→ WP2（1-2 天）──→ WP3
             └─→ WP4（REM-1..7 可并行）
WP5 各项独立，按 REM-8/9/10 → 11/12 → 13/14/15 顺序推进
WP6 持续；REM-23 建议在 WP4 完成后单独立项
```

## 执行监督

本方案的执行由双 agent 监督体系把控：每个 REM/WP 完成后由[监控 agent](./agents/monitor-agent.md) 做四层验收（静态存在性/动态执行/负向证伪/边界回归）并沉淀单任务经验；主 [agent](./agents/coordinator-agent.md) 定期汇总做跨任务模式识别与整体判定（ON-TRACK/AT-RISK/OFF-TRACK）。经验库见 [lessons-learned.md](./lessons-learned.md)，使用说明见 [agents/README.md](./agents/README.md)。执行约定：提交信息带 `REM-N:` 编号，文档类与代码类改动拆分 PR。

## 风险与回滚

- 全部工作包不触碰发布门禁（L1-L4 evidence 体系）与沙箱安全核心；WP4 各项均有独立测试可回滚。
- REM-3/11/12 涉及 spec 决策点（priority 槽位、provider 接线、阈值），落地前需 BDFL 在本文件上批注选择。
- 文档类改动（WP1/WP2）建议单独 PR，便于逐条 review 与追溯。
