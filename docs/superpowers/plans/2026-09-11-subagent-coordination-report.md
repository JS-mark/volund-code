# Subagent 协同管理分析报告（全端覆盖）

> 2026-09-11 · 范围：`packages/subagent`、`packages/tools`、`packages/app-runtime`、`apps/cli`（TUI + 非交互）、`apps/web` + `packages/web-server`、`apps/mobile` + gateway 链路
> 方法：逐文件代码核对 + 规格（02-agent-loop §2.7 / 04-tools-permissions §144）对照。所有断言带 `file:line`。
> 结论先行：**内核机制基本健康，治理有 4 个实质漏洞；四端呈现"一个机制、四种行为、零协同设计"的碎片化状态；文件协同靠"锁 + 字符串 CAS"隐式工作但有 4 个洞。统一事件层是全部改造的共同地基。**

---

## 1. 共享内核：机制现状

### 1.1 生命周期与隔离

- 链路：`TaskTool`（`packages/tools/src/index.ts:640`，volund.orchestration 域，`parallelSafe=true`）→ `SubagentDispatcher.dispatch()`（`packages/subagent/src/index.ts:186`）→ `createRunner` 工厂（`apps/cli/src/runtime.ts:925`）完整重装配子 Runner。
- 隔离：独立 SessionState / messages / 权限缓存；继承父的工具注册表快照、MCP 共享连接、插件装载表。子事件经 `EventBus.forward` 冒泡到父总线，保留原 `event.id`，envelope 加 `parentTurnId` / `parentDepth` tag（`packages/core/src/event-bus.ts:53`）。
- 权限：子会话冻结继承父快照（`packages/app-runtime/src/permission.ts:89`）；W8 降档已落地——`depth>0` 可授权档位只剩 allow-once / allow-session / deny（`permission.ts:503`）。
- 限额：`maxDepth` 硬钳 ≤3（`index.ts:98`）；`maxConcurrency` 默认 4；预算三维（cost/token/time）+ `toolCallMax`，子 Runner 每 loop 迭代前检查，耗尽 → `error.raised(subagent_budget_exhausted)` + partial 结果返回（`packages/core/src/runner.ts:181,506`）。
- agent 定义：两层 `.md` 装载（`~/.volund/agents` trusted / `<cwd>/.volund/agents` untrusted 正文包裹，`packages/subagent/src/agent-registry.ts`）；tools 白名单只能收紧（schemas + execute 双处过滤，`runtime.ts:1442-1466`）。

### 1.2 文件并发（多 agent 同文件协同的现状语义）

所有写工具走 `mutateFiles()`（`packages/tools/src/index.ts:139`），三闸：

1. **悲观串行化**：per-path lockfile `<path>.volundlock`，`wx` 独占创建，4×1s 重试后报持锁 pid（`index.ts:202`）。**跨进程有效**。
2. **乐观 CAS**：Edit/MultiEdit 三处校验 mtime+size 快照；真正的合并语义靠 `old_string` 精确匹配——两个 agent 改同文件**不同区域**天然串行合并成功；同区域 → `old_string not found / ambiguous` → 失败方 re-Read 重试。
3. **事务性**：tmp+rename 原子写、写后 size 复核、backup 事务失败回滚（`/undo` 可退）。

### 1.3 治理漏洞（内核层，承接 2026-09-11 会话前两轮分析）

| # | 级别 | 问题 | 位置 |
|---|---|---|---|
| G1 | P0 | **预算可被模型自抬**：`{...defaultBudget, ...input.budget}`，Task 入参 budget 由模型生成，传 `costUSDMax:1000` 即解除上限 | `index.ts:220` |
| G2 | P0 | **并发超限抛异常而非规格要求的排队**（spec r13-D1 钉死"排队执行不是拒绝"） | `index.ts:193` |
| G3 | P0 | **agent 定义 tools 超父集不拒绝**：`parseAgentDefinition` 的 `allowedTools` 校验未接线 | `agent-registry.ts:81` |
| G4 | P1 | 无会话级聚合预算：4 并发 × N 轮可累积任意总成本 | — |
| G5 | P1 | `maxDepth` 硬钳 3，config 只能调低（规格说"可配置"）；`toolCallMax` 违反三维 budget 钉死 | `index.ts:98` |
| G6 | P2 | W13 未落地：hook ctx 无 `depth`/`isSubagent` | — |

文件协同四洞（详见 §5.7）：

| # | 问题 | 位置 |
|---|---|---|
| F1 | **Write 盲覆盖**：无 `expect`，整文件覆盖静默丢先完成方改动（唯一真数据损失路径） | `index.ts:280` |
| F2 | mtime+size 非内容指纹：同毫秒/同尺寸两次写 CAS 失效 | `index.ts:95-105` |
| F3 | **Bash 完全绕过**锁/backup/新鲜度失效 | — |
| F4 | 死锁文件无回收：crash 残留 `.volundlock` 永久占位 | `index.ts:202` |

---

## 2. 四端现状

### 2.1 TUI（`packages/ui` + `apps/cli`）

**有的：**
- `/subagents` 面板 = 全产品**唯一**的 subagent 管理面（`packages/ui/src/subagents-panel.ts`、`components/SubagentsPanel.tsx`）：列表 / Enter 详情（prompt/用量/工具数）/ `x` 单取消 / `a` 全停 / 过滤 / 1s 轮询热更。控制器在 `runtime.ts:874`，经 appKernel 面板收集器注册（`runtime.ts:901`）。
- 权限共享审批队列（§22 W-07）：子代理权限请求进共享队列，TUI/Web 双端可批。

**没有的：**
- **主转录静默**：冒泡事件被显式过滤（`packages/ui/src/app.tsx:425`——`parentTurnId in event || parentDepth>0` 即丢弃），子代理执行期间用户只看到 Task 工具卡挂起。规格 §2.7 的"UI 折叠渲染 🤖 Subagent 正在执行..."未实现。
- 面板无实时进度（只有状态行 + 1s 轮询的用量快照）、无 pending 态、无分区/冲突信息、无累计聚合。
- **运行历史纯内存**：进程退出清零；`/config` reload 时即使无运行中任务也整体重建 dispatcher（`runtime.ts:808`），历史 100 条一并蒸发。
- 权限弹窗无归属标注（见 §3）。

### 2.2 CLI 非交互路径（`--json` NDJSON）

- `MachineEventFormatter`（`packages/core/src/machine-output.ts:38`）**丢弃血统标记**：`MachineEvent` 结构无 `parentDepth`/`parentSessionId` 字段。冒泡来的子代理 `stream.delta` 被格式化为 `text.delta`（带子 sessionId、子 messageId），与父输出**交错且无任何区分**——CI/脚本消费者无法归因。
- **无 `volund agents` 命令组**（`apps/cli/src/commands/` 只有 config/doctor/history/memory/status/telemetry/trust）：agent 定义列表、运行查询、预算读数在终端层完全缺席。
- JSONL 里有全部原始冒泡事件（落父会话文件），但无派生视图——数据在、不可读。

### 2.3 Web 控制台（`apps/web` + `packages/web-server`）

**有的：**
- SettingsPage 有 `[subagent]` 段配置编辑（`apps/web/src/components/SettingsPage.tsx:1371-1385`：max_depth / max_concurrent / default_budget）。
- SSE 事件管道透传 core 事件（`packages/web-server/src/session-hub.ts:176-179`——envelope 只加外层，payload 原样）。

**没有的：**
- **API 零覆盖**：`web-server/src/index.ts` 全部路由（sessions/config/status/models/permission-mode/remote/session-groups/workbench/terminal）无任何 subagent 端点。
- **聊天流交错泄漏**（本报告最重要的跨端发现）：`session-stream.ts` reducer 不看 `parentDepth`/`parentTurnId`，envelope 侧 sessionId 过滤只比对活动会话（`session-stream.ts:388`）而信封 sessionId 永远是活动会话——冒泡的子代理 `stream.delta` 直接以**无标注 assistant 气泡**混入聊天流（`session-stream.ts:182-196`），与主对话交错；子代理的 tool.started/completed 同样混入工具卡列表。用户看到的是"机器分身在不明所以地说话"。
- StatsPage / StatusPage 无 subagent 成本聚合（StatsPage 只平铺 summary/health 行）。
- 无取消能力、无运行历史、无折叠视图。

### 2.4 Mobile（`apps/mobile`，经 gateway）

- 视图 = Welcome / Pair / Sessions / Chat / Mine（`apps/mobile/src/components/`）：配对、会话列表、聊天、远程审批。**无任何 subagent 面**。
- **同样的交错泄漏**：`lib/chat.ts:173-186` 的 `stream.delta` 处理与 Web 同构，冒泡子代理文本无标注混入。
- gateway 协议（`lib/gateway.ts`）的信封 `kind` 无 subagent 语义；remote actions 通道（`/api/v1/remote/actions`）没有 subagent 取消动作。
- 远程审批可用（权限队列经 gateway 到手机），但审批卡同样**无归属标注**——手机上批一个 Bash 权限时不知道是主会话还是某个 subagent 在要。

---

## 3. 跨端不一致汇总（核心问题一览）

同一条冒泡事件链，四端四种行为：

| 维度 | TUI | Web | Mobile | CLI `--json` |
|---|---|---|---|---|
| 冒泡 stream 文本 | **显式过滤**（静默） | **无标注交错气泡** | **无标注交错气泡** | `text.delta` 带 child sessionId，无血统标记 |
| 运行管理面 | `/subagents` 面板 | 无 | 无 | 无 |
| 取消能力 | 单取消 + 全停 | 无 | 无 | 无 |
| 运行历史 | 内存 100 条，重启/reload 清 | 无 | 无 | 原始事件在 JSONL，无派生视图 |
| 权限审批归属 | 无标注 | 无标注 | 无标注（远程审批） | N/A |
| 预算/成本可见性 | 单次运行详情 | 无 | 无 | 无聚合 |

结论：**没有一端的行为是"对"的**——TUI 过滤过度（静默），Web/Mobile 泄漏（噪音无归属），CLI 丢标记（机器消费者失明）。根因是缺少统一的 subagent 领域事件层与各端共用的折叠/归属语义。

---

## 4. 目标设计

### 4.0 统一数据层（B 系列，一切的地基，先行）

- **B1 · 领域事件对**：`subagent.dispatched`（sessionId/parentTurnId/agentType/depth/budget/promptDigest）+ `subagent.settled`（status/usage/toolCalls/durationMs/detail?/conflicts?）。发父总线（与 `shell.background_*` 同构先例），随父 JSONL 落盘，event.id 幂等。落地走事件清单 8 处同步点（含 3 个硬编码计数守卫）。
- **B2 · 注册表重建**：运行注册表 = 内存 live + 从父 JSONL `subagent.*` 重放重建（resume / 面板首次打开时懒重建）。修掉 `runtime.ts:808` reload 清历史路径。
- **B3 · 聚合派生**：per-turn / per-session 的 subagent 成本与次数从 settled 事件派生，供四端页头/统计页。
- **B4 · 血统贯通到各端协议**：`MachineEvent` 增加可选 `parentDepth`（v1 协议向后兼容）；Web/Mobile reducer 以 `parentDepth>0` 为折叠分支依据。

### 4.1 TUI

- 主转录**折叠行**（补规格承诺）：app.tsx 过滤分支从"丢弃"改"聚合"——Task 挂起期间渲染 `🤖 agentType · running · 当前工具`，完成收成 `✓ agentType · 34s · $0.12`。
- 面板增强：pending 态、行内实时工具进度（数据源 = 冒泡事件聚合）、按 turn/agentType 过滤、页头聚合（runs N · $X.XX）、冲突重试计数、writePaths 分区显示。
- 权限卡归属：`InteractivePermissionRequest` 加 lineage 摘要（`Subagent 'reviewer' (depth 1)`）。

### 4.2 Web 控制台

- **API**：`GET /api/v1/subagents`（live + 重放历史）、`POST /api/v1/subagents/:sessionId/cancel`、`POST /api/v1/subagents/cancel-all`。SSE 无需新通道——B1 事件经既有 core 信封自然到达前端。
- **SubagentsPage**：实时运行表（状态/时长/用量/进度/分区）、详情抽屉（prompt/工具时间线/冲突）、页头聚合；移动端布局同源。
- **聊天流修复**：session-stream reducer 加 `parentDepth` 分支——子代理气泡归组到 Task 工具卡下的折叠子线程（与 TUI 折叠行同语义），不再平铺交错。
- StatsPage 加 subagent 成本段；SettingsPage 文案随 G1 修复改为"上限内收紧"。

### 4.3 Mobile（经 gateway）

- Chat 加**折叠条**（agentType + 状态 + 时长，点击展开子线程）——与 Web 同语义，数据经既有 gateway 事件信封到达，零协议新增。
- 审批卡归属标注（同源字段）。
- 取消操作：`/api/v1/remote/actions` 加 `subagent.cancel` 动作（二期；一期只读折叠条即可用）。

### 4.4 CLI 非交互

- `--json`：`MachineEvent` 加可选 `parentDepth`（+ `parentSessionId`），机器消费者可归因。
- **`volund agents` 命令组**：`agents list`（定义枚举 + 信任域 + tools 白名单）、`agents runs [session]`（从 JSONL 派生运行史，复用 replay）。定义模板生成可后置。

### 4.5 管控层（G 系列修复）

- G1：budget 逐维取 min（模型只能收紧）；G2：并发 FIFO 排队 + pending 态；G3：`discover()` 接线 `allowedTools`；G4：`[subagent] session_budget` 会话聚合上限；G5：放开 maxDepth 钳制、退役 toolCallMax（归 maxTurns/maxToolLoopsPerTurn）；G6：W13 hook ctx 字段。
- TaskTool.timeoutMs 与生效 budget.timeMsMax 联动。

### 4.6 文件协同层（F 系列修复 + 协同协议）

- F1：session 级 read-tracking（(session,path)→内容 hash），Write 默认要求 `expect=last-read hash`，失配 → changed-since-read；保留显式 `force`（标注 lost update）。
- F2：快照升级为内容 hash（xxhash64）。
- F4：锁 liveness 检查（pid ESRCH + 锁龄双条件）抢占。
- F3：Bash 成功后失效本会话 read-cache（尽力而为 + 锁等待不计 budget 时间）。
- **writePaths 派发契约**：Task input 可选 glob 数组，工具层强制越界即拒（对齐 tools 白名单"只能收紧"）；冲突计数进 `subagent.settled`。
- **worktree 隔离派发**（`isolation:'worktree'`，独立立项）：子代理在 `.volund/worktrees/<sessionId>` 跑，产出以 patch 返回父审批后 apply。终态形态，顺手解决 Bash 绕锁。

---

## 5. 路线图

| 批次 | 内容 | 量级 |
|---|---|---|
| **1 地基** | B1 事件对 + B4 血统贯通 + G1/G3 + F1/F2/F4 | 小-中，互独立可并行 |
| **2 端呈现统一** | TUI 折叠行 + 面板增强；Web API + SubagentsPage + 聊天流修复；Mobile 折叠条；CLI `--json` 字段 + `volund agents` | 中，最大批 |
| **3 协同协议** | G2 排队 + pending；writePaths；冲突可观测（E1）；权限归属四端 | 中 |
| **4 独立项** | G4 聚合预算；worktree 隔离；W13；Mobile 取消动作 | 按需立项 |

依赖关系：批次 2 全部依赖 B1/B4；批次 3 的冲突可观测依赖 settled 事件；writePaths 与 G1 同改 Task schema 宜同批。

---

## 6. 决策点汇总（待拍板）

1. **G1**：Task 入参 `budget` 保留（只许收紧）还是删除。
2. **G4**：会话聚合预算是否做、默认值（建议 $20，config 可关）。
3. **交错泄漏口径**：四端统一为"折叠呈现"（推荐，保留活动感）还是统一为"全端过滤"（最简，但彻底静默）。
4. **Mobile 取消**：一期只读还是连取消动作一起做。
5. **`--json` 协议**：v1 加可选字段（推荐，向后兼容）还是 v2。
6. **worktree 隔离**：是否列入路线图（建议列，批次 4 立项）。

---

## 附录：核对文件清单

- 内核：`packages/subagent/src/{index,agent-registry}.ts`、`packages/tools/src/index.ts`（Task/Read/Write/Edit/MultiEdit/mutateFiles/锁）、`packages/core/src/{runner,event-bus,machine-output}.ts`、`packages/app-runtime/src/{session-controller,permission}.ts`、`apps/cli/src/runtime.ts`
- 事件：`packages/shared/src/events/{envelope,turn-started}.ts`（26 种无 subagent.*）
- TUI：`packages/ui/src/{subagents-panel.ts,app.tsx:425,components/SubagentsPanel.tsx}`
- Web：`packages/web-server/src/{index,session-hub}.ts`、`apps/web/src/lib/session-stream.ts:182,388`、`apps/web/src/components/{SettingsPage,StatsPage,RemotePage}.tsx`
- Mobile：`apps/mobile/src/lib/{chat.ts:173,gateway.ts}`、`apps/mobile/src/components/`
- 规格：`docs/superpowers/specs/2026-07-31-volund-code-design/{02-agent-loop §2.7, 04-tools-permissions §144}.md`
