> ↩ [返回索引 (README)](./README.md) · ← [上一轮: REVIEW-r10](./REVIEW-r10.md)

---

# REVIEW r11 · 文档正确性审计：spec / ADR / 治理文档 vs 实现

- **审查范围**：设计文档体系（spec 各卷 + ADR + AGENT.md/CLAUDE.md + 16-capability-traceability）与当前实现的一致性。r6-r10 审的是"设计好不好"，本轮只审"**文档说的是不是真的**"。
- **审查日期**：2026-08-15（基准：main `5fa00a7`）
- **审查方法**：五路并行核查——①插件系统（06a/06b/PLUGIN-PROVIDER-r1 ↔ plugin-runtime/native-bridge/volund-sandbox）②记忆系统（06c + ADR-0010/0011 ↔ storage/cli）③终端 UI（07 ↔ packages/ui/apps/cli）④治理文档（AGENT.md/CLAUDE.md 逐条）⑤其余卷（11/15/README/10/16）。全部结论附代码 file:line 证据；关键断言（插件 prompt 注册抛错、preToolUse 未派发、evolution observe 未接线、`pnpm build:native` 幻影命令）经主审独立复核。
- **整改方案**：本文档只判定真伪；每条差异的处置（改代码追设计 / 改文档认现实）全部转入 [**设计一致性整改方案**](../../../superpowers/plans/2026-08-15-design-remediation.md)。

---

## 第一部分 · 总体判定

**结论：文档体系当前不能作为「AI 可执行契约」使用。** §12.6b 确立"spec 即契约"原则，但四层文档（spec 卷 / ADR / 治理文档 / 状态追踪）中：memory 主题已被 ADR 合法重设计、spec 与治理文档却未回收；插件与 TUI 的 spec 仍把未实现的 API 写成既定事实；治理文档 24 条过时/幻影条目会直接误导按文档行事的 AI 代理。

| 文档 | 审计条目 | 过时/幻影¹ | 部分准确 | 总判定 |
|---|---:|---:|---:|---|
| AGENT.md（插件/UI/memory/@include 相关） | 48 | **14** | 12 | 🔴 不可信，需立即修订 |
| CLAUDE.md（同主题） | 21 | **10** | 5 | 🔴 不可信，需立即修订 |
| 06a-plugins-core.md | 10 大项 | 4 整块未实现² | 3 | 🟡 核心架构描述准确；API 表面未标注实现状态 |
| 06b-prompt-composer.md | priority 表 8 行 + 生命周期 | 2 行未实现 + 3 项偏差 | — | 🟢 最接近实现的一卷 |
| 06c-memory-system.md | 全卷 | **全卷已被 ADR 取代** | — | 🔴 需整体标记 superseded |
| 07-terminal-ui.md | L1 验收 8 项 | 4 项未达 | 2 | 🔴 L1 承诺与实现脱节，无状态标注 |
| PLUGIN-PROVIDER-r1.md | 16 项能力 | **6 项核心未落地** | — | 🔴 标 "Approved" 且声称 L3 上线，实际 CLI 未接线 |
| 15-self-evolution.md | 10 项 | 5 项偏差/未接线 | — | 🟡 实现超预期，但语义与闭环状态失实 |
| 11-cli-commands.md | 命令面 | **~9 处** | — | 🔴 命令名体系漂移最大 |
| README.md（spec 索引） | 状态/TL;DR | 3 处 | 2 | 🔴 状态定位自相矛盾 |
| 10-milestones.md | 旧版 L2/L3 声明 | 6 条虚高（旧版） | — | 🟢 现版已自我修正；但其指定的权威文件 16 卷过时 |

¹ "幻影" = 指向不存在的包/API/配置/命令/文件。
² 出站事件推送+背压、VolundBridge 四个假命名空间、provider 插件接线、附件 handle-token。

---

## 第二部分 · 逐文档审计结论

### 2.1 AGENT.md / CLAUDE.md（治理文档，最高危）

memory 相关条目几乎全灭（存储形态、scope 命名、工具名、限制轴、配置键全部失实），插件相关 8 条过时，另有两条"按字面执行会破坏代码库"的禁令：

- `CLAUDE.md:96`"禁止在 packages/core 之外实现 @include"——现实是**唯一实现就在 core 之外**（`packages/storage/src/index.ts:105` `PromptLoader`，O_NOFOLLOW/深度 8/双白名单均在此）；AGENT.md:288 同样指错位置。
- `AGENT.md:193`"AST 静态检查保留"——全仓库零实现；实际防线是 Rust 沙箱+bridge 白名单（06a 已降级该检查的地位，但"降级版"也没写）。

其余高危：`AGENT.md:269-278`（md+frontmatter/200 行/`volund.memory.recall` 工具/`pinned_inject_max_lines` 配置）、`AGENT.md:60,281`+`CLAUDE.md:90`（`packages/memory-runtime` 幻影包）、`AGENT.md:207`+`CLAUDE.md:80`（`volund.provider.register`"受控开放"——bridge 自认 unsupported，`plugin-runtime/src/index.ts:590-596`）、`AGENT.md:279`+`CLAUDE.md:95`（`permissions.memory` 形状与 `-32601` 错误码——实际形状不同，错误码是 `plugin_rpc_method_denied`）、`AGENT.md:195`（`plugins.enabled.toml`——实际 `plugins.json`）、`AGENT.md:235-237`（plugin-sdk 依赖与 `defineHook/defineCommand` 导出）、`CLAUDE.md:52`（C2 让 AI 优先用 `volund-search`——builtin 工具集里根本没有，`tools/src/index.ts:482-494`）、`CLAUDE.md:54`+`CONTRIBUTING.md:60`（`pnpm build:native` 幻影命令，root/turbo/scripts 均无）。

另有维护纪律失守：`CLAUDE.md:3-4` 声称"通用约定只在 AGENT.md 维护、本文件不重复"，但 C4 第 90-100 行逐条复述了 §4.14/§4.15 且与之**一起过时**——单一事实源已裂开。

### 2.2 06a-plugins-core.md（插件核心）

**准确且已实现**：每插件一子进程 + `volund-sandbox --run-plugin`（`crates/volund-sandbox/src/plugin.rs:41-89`，bridge-fd=3、entry/read-roots 校验、宿主 loader 编译进二进制）；双层白名单（全局方法表 + per-manifest，`plugin-runtime/src/index.ts:457-499,902-911`）；activate 10s 超时 + SIGKILL（`native-bridge/src/sandbox.ts:106-108`）；权限升级再弹窗（`index.ts:390-397` + `plugin_approval_stale` :831-836）；3 次失败自动 disable（:428-435）。

**写了但整块未实现**（spec 无任何标注）：

| spec 声明 | 现实 |
|---|---|
| §6.4.1 `session.on` 事件订阅 + §6.4.3 出站事件背压（r6 P0-4 全套：256 队列/drop 策略/telemetry） | `session.on` 为 no-op（`index.ts:1290-1293`），无 notification 通道，背压契约整体不存在 |
| §6.4.1 `ui.*` / `http.fetch` / `storage`（落盘 dataDir）/ `config` | 宿主未接线：ui/http 抛 `plugin_*_not_connected`，storage 是内存 Map 不落盘，config 恒 undefined（`apps/cli/src/runtime.ts:1471-1497`） |
| §6.4.1 `provider.register`（受控开放） | 主进程 `registerProviderPlugin` 已实现有测试（`index.ts:972-1022`）但 CLI 零调用；bridge 不暴露该方法 |
| 附件 handle-token（`att_${uuid}` strip + readAttachment 分片） | 全仓库零实现；`session.getMessages` 直接 structuredClone，不 strip handle（`index.ts:1281-1286`） |

**细节偏差**：未声明方法返回 `-32000`+稳定 code 而非 `-32601`（刻意防泄露，`index.ts:722-731`）；审批存 `plugins.json` 非 toml；zod 校验未采用（手写检查）；`hooks.kv` 命名空间隔离未接线——生产恒 `${plugin}:activation`（`index.ts:849,1163`），跨 tool_use 共享，r9 要防的 parallelInvoke 竞态未防住；"500 calls/turn" 的 turn 维度疑似未接线（两路核查结论不一致：一路发现 turnId 恒 `'activation'` 且子进程 `MAX_CALLS=500` 为进程级，一路只核到默认值 500——整改时以专项测试裁定）；**插件 prompt 片段在生产 CLI 直接抛错** `plugin_prompt_registration_not_supported`（`apps/cli/src/runtime.ts:1399`，仅 command/tool 两类注册被接，主审复核确认）；`preToolUse`/`postToolUse` 类型存在但**从未派发**（全仓库无 `runHooks('preToolUse')` 调用点，主审复核确认）——06a §6.4.2 的招牌示例（git-helper veto `rm -rf`）当前根本跑不起来。

### 2.3 06b-prompt-composer.md

priority 表 8 行中 6 行与实现精确一致（builtin 1000 `core/src/prompt-composer.ts:82` / memory-guide 950 / pinned 700 / skill 800 / project `max(500,600-level*10)` / user 400）；**plugin 60/50 两个槽位未实现**（CLI 拒绝 prompt 注册，见上）。§6.11 生命周期大部分准确（热插拔、兜底 dispose、3 次失败 disable）。偏差：hook priority 分域（builtin 900-1000/project 500-899/plugin 0-499/user -1000~-1）实现为统一 `-100~100`（`index.ts:1229-1231`）；§6.11.4 生命周期事件推送未实现（`session.on` no-op）；bridge 调用超时实际 10s（spec 5s）、心跳 5s 发/30s 收（spec 60s）。

### 2.4 06c-memory-system.md（重灾区）

**全卷已被 ADR-0010/0011 合法取代，但未回收、未标注。** 逐轴对照：

| 轴 | spec §6.12 | 实现（=ADR） |
|---|---|---|
| 存储 | `~/.volund/memory/*.md` + frontmatter + `<cwd>/.volund/memory/` | 单文件 JSON 快照 `~/.volund/memory/records.json`（`apps/cli/src/runtime.ts:986`），原子写+`.bak` 回退（`storage/src/memory-runtime.ts:758-793`） |
| scope | global/project/tuning | workspace/project/session（projectId=sha256(cwd)，`apps/cli/src/memory-scope.ts:7-9`）；tuning 降格为 `provenance.source='evolution'` |
| 模型工具 | `Memory.recall/read/write/update/delete/list` | `Memory.create/get/list/update/delete/pin/unpin`（`apps/cli/src/memory-tools.ts`）；**模型无 recall**——召回只在 CLI `search`/TUI 面板/插件 bridge |
| 越权语义 | §6.12.2a "scope 越界仍正常返回（advisory）" | fail-closed（`memory-runtime.ts:224-232`）——**spec 内部自相矛盾**（§6.12.10 又要求必须过权限校验），ADR 改对了 |
| 内容限制 | 200 行四层降级 + 自动 split + `max_files_per_scope` | 64KiB 字节 + secret/Unicode/id 守卫（`memory-runtime.ts:243-273`），无条件不可禁用 |
| 配置 | `[memory]` 8 个配置项 | **一个都没实现**（400 行/2000 token 硬编码默认，`memory-prompt-provider.ts:36-39`） |
| CLI | `edit/rm/show` 等 | `list/get/add/update/delete/pin/unpin/search/doctor/reindex/export/import`（无 $EDITOR 工作流） |
| telemetry | 9 个事件 | 0 个，换成本地 audit jsonl |

**实现优于 spec 的部分**（ADR 层面的正确决策，spec 应吸收而非反之）：pinned 注入带 `<untrusted source="memory:pinned">` wrapper + XML 转义 + 双预算 + 窄 scope 优先（`memory-prompt-provider.ts:84-152`）——spec §6.12.8 的 pinned 注入反而**没有**要求 wrapper；索引恢复协议（dirty marker + fingerprint + 候选复核，`memory-index.ts`）。

**实现层的真实风险**（三层文档都没写）：import 可携带 `pinned:true` 直达 system prompt 且注入块不标来源（`memory-transfer.ts:147,190,199` + `memory-prompt-provider.ts:128-131`）；索引锁遇陈旧锁即抛 busy、不查进程存活（`memory-index.ts:441`，与事实库锁的 pid 检测不一致）；"事实已落盘但索引 upsert 报错"窗口会让自动 id 的 create 重试写出重复记忆（`memory-index.ts:661-706`）；单文件全量快照每次写 O(n)；session 记忆无 GC。

### 2.5 07-terminal-ui.md

**违反 spec 硬约束的实现**（spec 不需要改，代码需要追）：Ctrl+C 在 TUI 内=退出整个会话而非 interrupt（`ui/src/InputBox.tsx:73-76`，且 `InteractiveAppOptions` 无 interrupt 通道）；多行 fallback（Esc+Enter/Alt+Enter）缺失（`InputBox.tsx:103`）；`@` 统一 picker 是 L1 必交付项，纯函数+测试存在但 InputBox 未接线（`ui/src/index.ts:320-360` 仅测试消费）；权限键位 a/s/d ≠ 设计 y/n/s/f 且四档缺 forever/project（`PermissionPromptStack.tsx:61-65`）；`--yolo` 顶栏红条仅非 TUI 输出（`cli.ts:555`）；`--json --yolo` 把 ANSI 红条混入 NDJSON（`cli.ts:554-555`）。

**spec 自身的盲点**（本轮新增判定）：只规定 33ms buffer 未规定"delta 不得各自触发 setState"——实现每 delta 一次全树重渲染（`app.tsx:177`），节流被架空；未规定长会话滚动策略——实现用 `slice(-16)` 让旧消息不可回看（`ScrollableTranscript.tsx:11`）；未要求 NDJSON 真流式——实现是进程结束一次性写出（`bin.ts:24`）。

### 2.6 PLUGIN-PROVIDER-r1.md

标 "Approved 2026-08-01" 且 §P12 声称"header-template 模式随 L3 发版上线"。现实：主进程侧（manifest 校验/signing 门/header 渲染/registry/禁 default，`index.ts:263-297,972-1022`、`router/src/index.ts:433-435`）已实现且有测试，但 **bridge 无 provider/auth 命名空间、stream RPC 通道（§P4.4）零实现、telemetry 事件（§P13）零实现、CLI 只装配 Anthropic（`runtime.ts:1254-1259`）、`registerProviderPlugin` 全仓库零调用方**。"设计批准 ≠ 实现存在"落差最大的一卷。

### 2.7 15-self-evolution.md

不是纯设计：引擎（OHAV 循环/步长 clamp/恶化回滚/确认门，`core/src/evolution-engine.ts:79-392`）、tuning 存储（`storage/src/evolution-store.ts`）、`volund evolution show/rollback`、context 参数注入（`runtime.ts:1204-1211`）都是真实实现。失实处：Layer A 说 `scope:'tuning'`——实现无此 scope（provenance 标记）；**`observe()` 全仓库零调用（主审复核确认）——信号采集端不存在，引擎实际永不自调优，"反馈闭环"未闭合**；Router/Retry/Tool 三个接入点零接线；`evolution enable/disable` CLI 不存在；确认阈值实现 0.25 ≠ 文档 30%。

### 2.8 11-cli-commands.md / README.md / 10-milestones.md / 16 卷

- **11 卷**：约 9 处失实——plugin install 仅支持本地目录（npm/github spec 均无）；memory 子命令名体系漂移（见 2.4）；`config/history/model/skill/completion` 5 个顶层命令不存在；slash `/context` `/compact` 是 unavailable 桩（`ui/src/app.tsx:277-278`）、`/model` 依赖未接线的 modelPicker；`plugin upgrade/ban/dev/init` 未实现；telemetry `status`→实际 `show`。
- **README**：状态仍标 "🚧 brainstorming 阶段"——实现已覆盖大量 L2/L3 功能；TL;DR "MVP 范围 L4" 与自身目录表 "R0→R6" 自相矛盾；行数标注过期。
- **10 卷**：现版（`c6e1d99` 重写为 evidence-gated R0→R6）已自我修正且声明历史 ✅ 仅作线索；但它指定 16-capability-traceability.md 为 status authority，该文件冻结于 2026-08-10，至少 3 处 memory 判定已过时（标 `missing/absent` 的 Memory CLI/插件 bridge/runtime 均已存在）。

---

## 第三部分 · 高危误导条目（按"会让 AI 写错代码"排序）

1. `AGENT.md:269-270` + `CLAUDE.md:91`：按 md+frontmatter 实现 memory 读写 → 直接撞 JSON schema 校验，且写错路径。
2. `CLAUDE.md:96` + `AGENT.md:288`：@include 唯一实现位置指错（说在 core，实在 storage）；CLAUDE.md 禁令按字面执行=要求删除现有唯一实现。
3. `AGENT.md:278`：`volund.memory.recall` 工具不存在（正确名 `Memory.get/list/search`）。
4. `AGENT.md:279` + `CLAUDE.md:95`：`permissions.memory.contributePrompt` 之类形状非法（装载即抛 `plugin_manifest_invalid`）；错误码 `-32601` 不存在。
5. `CLAUDE.md:90` + `AGENT.md:60,281`：幻影包 `packages/memory-runtime`——诱导新建该包、割裂 storage 内聚实现。
6. `CLAUDE.md:54` + `CONTRIBUTING.md:60`：`pnpm build:native` 不存在——Rust 改动后执行必失败。
7. `AGENT.md:195`：审批状态写 `plugins.enabled.toml`（实际 `plugins.json` 状态机）。
8. `AGENT.md:207` + `CLAUDE.md:80`：`volund.provider.register`"受控开放"——照文档写出的 provider 插件运行即 unsupported，且没有任何替代路径被接线。

---

## 第四部分 · 三层矛盾焦点（同一主题多种说法）

| 主题 | spec 卷 | ADR/实现 | 治理文档 |
|---|---|---|---|
| memory 存储 | md+frontmatter（06c） | JSON 快照（ADR-0010） | md+frontmatter+200 行（AGENT §4.14） |
| scope 命名 | global/project/tuning | workspace/project/session | global/project 双目录 |
| 模型工具 | recall/read/write… | create/get/…/pin/unpin | `volund.memory.recall`（连调用方都写错：模型拿不到 bridge） |
| 越权语义 | "advisory 正常返回"（06c）vs "必须权限校验"（06c 自身） | fail-closed | 未提 |
| hook priority | 分域 4 区间 | 统一 -100~100 | 未提 |
| bridge 超时/心跳 | 5s / 60s | 10s / 5s+30s | 5s / 60s |
| 项目状态 | README: brainstorming / TL;DR: L4 | 10 卷: R0→R6 | 16 卷: 冻结于 08-10 |

---

## 第五部分 · 审计边界

- 本轮只判定"文档是否与现实一致"。"实现应该追设计还是设计应该认现实"属整改决策，逐条处置见整改方案。
- 所有行号基于 2026-08-15 main（`5fa00a7`）；文档修订后行号会漂移，以引用的符号名为准。
- 未覆盖：03/04/05/08/08b/09/12/13/14/16 卷的逐条审计（本轮聚焦插件/UI/memory 主题及其直接关联卷）；建议下一轮把同方法用于剩余卷。

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-15 | r11 v1 | 文档正确性审计：治理文档 24 条过时/幻影（AGENT 14 + CLAUDE 10）、06c 全卷被 ADR 取代未回收、PLUGIN-PROVIDER-r1 六项核心未落地、11 卷命令面 ~9 处漂移、README 状态自相矛盾；新增三条主审复核确认的关键事实（插件 prompt 注册生产抛错、preToolUse/postToolUse 从未派发、evolution observe 未接线）。配套整改方案另行发布。 |
