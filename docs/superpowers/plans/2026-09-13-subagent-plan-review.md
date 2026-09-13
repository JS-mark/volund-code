# Subagent 方案自审与业界对照（Review-r1）

> 2026-09-13 · 评审对象：[2026-09-13-subagent-governance-master-plan.md](./2026-09-13-subagent-governance-master-plan.md)
> 对照快照：Claude Code 官方文档（code.claude.com，agent-sdk/subagents + agent-view，2026-09）；OpenAI Codex（Symphony 编排规范 + Codex app worktree 并行）；pi（badlogic/pi-mono 极简内核哲学）。
> 结论先行：**方向层大半被业界验证（预算聚合、深度 3、worktree 隔离、/agents 管理、follow 模式、跨端审批呈现全部撞车）；三处需要改范式（后台化为默认、门禁走既有权限/hook 面、handoff 契约降级为 fork）；自审揪出一个新 P0（Task 结果未包 untrusted）。决策点从 9 修剪到 5。**

---

## 1. 总评

| 维度 | 裁定 |
|---|---|
| 被业界验证、原样保留 | 预算聚合（Claude `maxBudgetUsd` 同构）、深度默认 3（Claude 同值）、worktree 隔离（Codex app + Claude bg 都在用）、`/agents` 管理面、follow/peek 模式、needs-input 跨端呈现、事件+注册表持久化 |
| 范式修订 | ① subagent 后台化为默认（我们按"工具内同步 await"设计，业界已进化到"detached 会话 + supervisor"）；② 派发门禁弃自造 config 分类法，走既有 permission/hook 面（pi 启发）；③ handoff 契约降级——Claude 的父子上下文模型是"唯一载荷 = 工具 prompt + fork 可选"，比我的结构化交接更简单 |
| 我过度设计了 | handoff.{brief,files,constraints} 三元组、dispatch_policy 三档分类法、日级配额（YAGNI）、结构化输出 schema（降优先级） |
| 我漏了的（业界有） | 结果注入扫描、needs-input 独立运行态、disallowedTools/mcpServers/skills/permissionMode 富定义、fork 模式、并发默认值差 5 倍、活动摘要行、subagent 会话可 resume |

---

## 2. 业界对照与采纳

### Claude Code（最直接的对标）

| 业界机制 | 快照事实 | 对我们的采纳 |
|---|---|---|
| 后台默认 | subagent **background by default**；需要结果才 `run_in_background:false`；`background:true` 定义级强制 | 范式修订 R1：`runInBackground` 从"独立立项远期"**升级为核心里程碑**；事件/注册表设计不得假设 in-turn 生命周期（L0 已满足） |
| supervisor 进程 | agent view 的会话宿主：关终端/睡眠/自动更新都活着；空闲 ~1h 自停、按需恢复；崩溃自动重启；断电 48h 内可恢复 | 北极星 R1b：与 gateway-server/web 嵌入式天然亲和；一期不做进程守护，但注册表/事件必须为 detached 形态留位 |
| agent view | 全屏驾驶舱：状态图标（工作中/needs input/完成/失败/停止）、**小模型生成的一行活动摘要**、Space peek 读+回复、Enter 附着/←脱离、PR 状态标签、过滤/置顶/重命名 | L6 四端呈现的交互蓝本；"一行活动摘要"新增（N6）；peek=follow 模式；needs-input=权限待批运行态（N2） |
| 预算 | `maxBudgetUsd`：无默认上限，计 subagent 请求；执行=拒新派发+**停运行中的后台代理**+query 以 `error_max_budget_usd` 收尾 | 采纳执行语义补强我的 session 预算（原来只有"拒新"）；**默认值改为关**（对齐业界"无默认上限"），文档推荐显式设置——替代我原"默认 $20"建议 |
| 并发 | 默认 **20**，超限 spawn 失败（"Concurrent subagent limit reached"） | 我们默认 4 太保守（差 5 倍）且超限即错；修订：默认提到 8-12 + 按规格排队（排队仍是更好的行为，业界只是用高默认值回避了问题） |
| 深度 | env 可调，默认 3 | 验证 G5：放开硬钳，对齐 env/config 可调 |
| 定义 schema | `tools` + **`disallowedTools`**（含 `mcp__server__*` 通配）、`model`（别名/inherit）、**`skills`**、**`memory`**、**`mcpServers`**（per-agent MCP 域）、`maxTurns`、`background`、`effort`、**`permissionMode`**（per-agent） | N3：agent schema 富化——denylist 互补、MCP server 白名单（只可收紧）、skills 声明、permissionMode 覆盖（只可收窄）；一次 schema 扩批做掉 |
| 上下文模型 | fresh 但非空（自有 system prompt + 工具 prompt + 项目 CLAUDE.md）；**fork 继承父对话**；唯一父子载荷=工具 prompt；`SendMessage` 跨代理通信 | R3：handoff 契约**降级**为可选糖；**新增 fork 模式**（`fork:true` 继承父转录快照，配既有滑动窗口压缩）作为上下文连续性正解；SendMessage 记北极星 |
| 注入防御 | v2.1.210+ 对 subagent 输出做 control-tag 仿冒扫描（伪 `<system-reminder>` 反斜杠中和） | **新 P0（N1）**：我们的 Task 结果连 `<untrusted>` 都没包（描述却写着 untrusted）——先补包裹对齐自家插件/MCP 工具策略，再做 tag 扫描 |
| resume | subagent 会话可 `session_id`+`agentId` 续跑；一次性 Explore/Plan 不返回 agentId | N7：我们的 JSONL 全量已具备，settled 后"重开一个已完成的 subagent 继续"= 北极星；顺手固化两个**内置只读 agentType**（explore/plan——只读=免权限门+免 writePaths，便宜且高频） |
| /agents 命令 | 交互式创建/编辑/管理，project/user 两级 | 验证 L6 的 `/agents` 面板（含热重载）排期正确 |

### Codex（编排与隔离）

| 业界机制 | 对我们的采纳 |
|---|---|
| Codex app：多代理并行 + **worktree 隔离**（"agents 在各自 checkout 写，互不碰撞"） | 验证 E3；采纳 Claude 变体：**后台/隔离代理"动文件前"自动进 worktree**（`.volund/worktrees/`），config 可关——比"显式 isolation 参数"更顺滑的默认 |
| Symphony（开源编排规范）：issue tracker → 常驻 Codex 代理系统 | 北极星 R1c：与 spec §6.4.1a `volund.jobs.schedule` 空闲调度 + 后台代理组合=同型能力；detached 形态落地后自然够到 |
| AGENTS.md 仓库指令标准 | 已有（AGENT.md/CLAUDE.md 在仓）；子代理 prompt 组装时确认其注入语义与父一致（composer 已做，验收项即可） |

### pi（极简内核哲学）

| 业界机制 | 对我们的采纳 |
|---|---|
| 核心拒绝内置 subagents/plan mode，一切经 TypeScript extension（社区 pi-subagents 即装即用） | R2：**治理配置不新造分类法**——派发门禁=Task `permissionSpec` 接入既有权限链（ask 规则走 permissions.toml）+ W13 hook（PreToolUse veto 可按 depth 收紧）；"更严模式"=插件/hook 生态的活，不是 config 枚举的活。同时验证 C4（插件贡献 agent 定义）是正路 |
| 最小契约 + 用户自建 | 支持砍掉：日级配额降为 backlog、dispatch_policy 三档删除、handoff 三元组降级 |

---

## 3. 对 Master Plan 的修订清单（diff）

**升级**
- D4 `runInBackground` + 完成通知：独立立项 → **批次 3 核心**；同时确立"detached + supervisor"为 L6 北极星（web 控制台是最佳宿主）。
- 会话预算执行语义：补"停运行中后台代理 + 类型化终态错误"（对齐 `error_max_budget_usd`）。

**修订**
- L1.2 并发：默认 4 → **8-12**（新决策点 #3）；排队保留（优于业界的行为）。
- L1.3 派发门禁：~~dispatch_policy 三档 config~~ → **Task permissionSpec + permissions.toml 规则 + W13 hook**（R2）。
- L1.1 预算：session 预算默认 ~~$20 开~~ → **默认关**（对齐业界无默认上限），文档推荐值 $20。
- L3 上下文：handoff.{brief,files,constraints} → **可选糖（backlog）**；新增 **fork 模式**（继承父转录快照）为上下文连续性正解（R3）。
- L2.1 热重载：对齐 /agents 面板 r 键重扫（已有排期，验证）。
- G5 深度：放开硬钳改 config 可调（业界 env 可调同语义）。

**新增（本轮 review 产出）**
- **N1（P0）**：Task 工具结果补 `<untrusted source="subagent:<agentType>">` 包裹（对齐插件/MCP 工具输出策略，`tools/index.ts:685` 一行修）；二期加 control-tag 仿冒扫描。
- N2：`needs-input` 独立运行态（=权限待批），四端状态枚举统一（working/needs-input/done/failed/stopped/pending）。
- N3：agent schema 富化批：`disallowedTools`、`mcp: [server]`（只可收紧）、`skills`、`permissionMode`（只可收窄）、`context.maxTokens`（保留，只可小于父）。
- N6：运行行的一行活动摘要（小模型生成，agent view 同款）。
- N7：内置只读 agentType `explore`/`plan`（免权限门+免 writePaths，高频便宜）；subagent 会话 resume 记北极星。
- N8：worktree 自动隔离策略：后台/隔离代理动文件前自动进 worktree（config 可关）。

**删除/降级**
- 日级配额 → backlog；dispatch_policy 三档 → 删（被 R2 取代）；handoff 三元组 → 糖；结构化输出 schema → 降优先级（Claude 也只回最终文本，monitor/coordinator 消费自由文本已被 repo 文化验证）。

**我方领先项（不必跟业界走）**
- 文件层 lockfile+CAS 双闸（业界 subagent 同文件主要靠 worktree 回避，我们的乐观合并在"无隔离并行"场景更强）；
- 冒泡事件保留 event.id 的重放幂等设计；W8 权限降档比业界细。

---

## 4. 修订后路线图

| 批次 | 内容（含修订） |
|---|---|
| **1 地基** | L0 事件对/注册表/血统 + **N1 untrusted 包裹** + 预算逐维钳制 + 装载校验/热重载 + 文件层 Write-expect/hash/死锁回收 + 孤儿 shell 收编 |
| **2 端统一** | 四端呈现（状态枚举含 N2 needs-input + N6 摘要行）+ follow/peek + `volund agents` + `/agents` 管理（热重载）+ 内置 explore/plan（N7 前半） |
| **3 协同协议** | **runInBackground + 通知（升级）** + 并发排队（默认 8-12）+ 门禁走权限/hook 面（R2）+ fork 模式（R3）+ writePaths + N3 schema 富化批 |
| **4 治理深化** | 会话预算（执行语义含停跑+类型化错误）+ model 白名单 + 沙箱深度递进 + W13 + telemetry span + N8 worktree 自动隔离 |
| **北极星（不排期，形态就绪即启）** | detached supervisor + agent view 全功能（peek/回复/附着）+ SendMessage 跨代理 + subagent resume + Symphony 型 jobs 编排 |

## 5. 修剪后决策点（9 → 5）

1. Task `budget` 入参：保留只许收紧（推荐）或删除。
2. **runInBackground 进批次 3** 是否接受（架构牵动 turn 生命周期，是本方案最大的一步）。
3. 并发默认值：8 还是 12（原 4 作废）。
4. fork 模式是否随批次 3 一起做（推荐一起，与后台化共享"会话快照"设施）。
5. N8 worktree 自动隔离默认开还是显式 opt-in（Claude 默认开可关；我倾向 volund 先 opt-in，农忙期稳一点）。

~~原 #4 digest 阈值 / #5 handoff 计费 / #7 memory 只读 / #8 --json v1~~：技术细节非方向，按推荐值执行；~~#6 dispatch_policy / #9 立项顺序~~：被 R2/路线图取代。

---

## 6. 来源

- [Subagents in the SDK – Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Manage multiple agents with agent view – Claude Code Docs](https://code.claude.com/docs/en/agent-view)
- [Symphony: An Open-Source Spec for Codex Orchestration – OpenAI](https://openai.com/index/open-source-codex-orchestration-symphony/)
- [Multi-Agent Orchestration With Codex — Firecrawl](https://www.firecrawl.dev/blog/codex-multi-agent-orchestration)
- [The Code Agent Orchestra — Addy Osmani](https://addyosmani.com/blog/code-agent-orchestra/)
- [Pi Coding Agent](https://pi.dev/) · [pi-mono (GitHub)](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- [Pi Mono Explained: The Anti-Framework](https://hoangyell.com/pi-mono-explained/)
