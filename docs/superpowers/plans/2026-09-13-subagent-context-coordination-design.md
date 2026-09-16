# 多 Agent 协同与上下文管控设计（Consolidated Design）

> 2026-09-13 · 定位：[master plan](./2026-09-13-subagent-governance-master-plan.md) L3/L4 与 [review-r1](./2026-09-13-subagent-plan-review.md) 修订的**合并完整版**——review 的 diff 体例把两域冲散了，本文恢复为自洽设计，作为 spec §2.7bis 的直接蓝本。
> 2026-09-16 r2 修订：评审清单落地——digest 摘要截断 + 落盘 Read 同权包裹、worktree 基线语义、fork 深拷贝 + 体积闸、handoff 双闸、U2 会话归属钉死、/undo 措辞澄清、inject/排队类型化错误、无先前读写语义、U2 提前批次 2；新增 §6 UI 面（TUI/Web/Mobile）。
> 同日 r2b：全量复查补修——digest 磁盘引用可读通道、worktree 内部写不进根 manifest、锁表视图数据源修正、并发/预算现状注记；新增 §7 插件扩展面。
> 原则回顾：最小动词集（pi）、fresh-but-not-empty + fork（Claude）、worktree/Symphony（Codex）、我们自有的 lock+CAS 与 event.id 幂等。

---

## 0. 总览

**上下文管控 = 三口一门**（下行交接 / 子内部 / 上行回传 / 聚合账本）——治理的是 token 在 agent 间的流动。
**多 agent 协同 = 四面**（结构 / 通信 / 编排 / 仲裁）——治理的是 agent 间的执行关系。

| | v1（批次 1-2 可达） | v2（批次 3-4） | 北极星（detached） |
|---|---|---|---|
| 下行交接 | fresh + prompt | + fork / handoff 糖 | 同 |
| 上行回传 | untrusted 包裹 | + digest 封顶 | + 结构化 schema 可选 |
| 通信 | 一次性 + 进度事件 | + steering / 后台通知 | SendMessage 跨代理 |
| 结构 | 共享树 + 锁/CAS | + writePaths / worktree | detached 会话 + supervisor |
| 文件共享 | 三入口只闸 agent 工具 | 三入口统一 + /undo 全树 | 同 |
| 编排 | 串行 Task | dispatchBatch / 模板 | jobs 调度（Symphony 型） |
| 可见性（UI） | TUI 面板已有 + 混流/归属缺陷修复（§6.1） | Web SubagentsPage + 三端 ctx%/通知（§6.2） | Mobile push（§6.2） |
| 插件扩展 | 工具/fragments/hook 已天然覆盖子会话（§7.2） | + agent 定义注册 / dispatched·settled hook（§7.1/7.3） | 模板生态（§2.3 模板=插件，§7.1） |

---

## 1. 上下文管控

### 1.1 下行：父→子交接（ingress）

子代理基线载荷（所有模式共享，"fresh but not empty"，对齐 Claude 模型）：自有 system prompt（agent 正文，project 级包 `<untrusted>`）+ 项目 AGENT.md（composer 既有注入）+ 工具定义 + **已激活插件的 prompt fragments**（子会话复用同一 createRunner/composer 装配，`plugin:<名>:` 命名空间注入——现状即如此，r2b 钉入基线定义；agent 定义 `tools` 白名单可将其裁掉）。**不含**父历史/工具结果/权限缓存（spec 钉死的隔离）。

三种交接模式：

| 模式 | 契约 | 适用 | 成本 |
|---|---|---|---|
| **A · fresh + prompt**（缺省） | Task `prompt` 自包含（模型写清楚路径/报错/目标） | 探索、检索、独立小任务 | 最低；隔离最大 |
| **B · fork** | `fork: true`：dispatcher 把父 transcript **冻结快照**作为子初始 messages（只读副本；子继续累积自己的） | 深挖当前调查线、父临近压缩时的上下文卸载 | token 复制；子的滑动窗口压缩兜底 |
| **C · handoff 糖**（可选，backlog） | `handoff: { files?: string[], brief?: string }`：files 由 dispatcher 预 Read 注入子首条上下文（token 计子预算），brief 进 composer 独立槽位 | 明确文件集的实现型任务 | 省父 prompt 内联 |

实现注记：fork = dispatcher 内 `updateSession(createSession(...), d => d.messages = structuredClone(parent.state.messages))`——**必须深拷贝**：`[...messages]` 浅拷贝共享消息对象引用，父侧任何原地变更（压缩截断/redaction）会追溯改写子的"只读"快照。**fork 体积闸**：快照预估 token > 子 `context.maxTokens` 的 60% → dispatcher 类型化拒绝（提示改用 A）——父临近压缩时 fork 只会产出"出生即压缩"的白费单。C 的 files 预读复用 AttachmentStore 权限根（cwd 内），**注入量双闸**：单文件 ≤512KB 且单次 handoff 总量 ≤2MB（对齐 workbench 读写上限），超限 dispatcher 拒绝并指明超限项。

**模式选择不是用户决策**：prompt 引导模型缺省 A；模型显式传 `fork:true` 才 B。规范侧只钉"prompt 必须自包含关键事实（路径/约束/完成标准）"的提示词纪律。

### 1.2 子内部：上下文预算与压缩

- **per-agent 上下文上限**：agent 定义 `context.maxTokens`（只可小于父继承值；缺省=父值，现状）。dispatcher 建会话取 min。
- **压缩**：子 Runner 滑动窗口压缩已生效（`runtime.ts:1066`，验证项非新建）；composer 槽位（agent 正文/constraints）在压缩后重注入——任务关键约束不丢。
- **压力信号（新增，小）**：`SubagentRunEntry` 增 `ctxUsagePct`（live，来自子 state），运行行显示 `ctx 78%`——人看到"快爆了"，模型看不到（它有自己的 runner 信号）。
- **概念切分（spec 语言）**：`tokenMax`（三维预算，治**钱**）≠ `context.maxTokens`（窗口，治**状态**）≠ digest 封顶（§1.3，治**父污染**）。三者独立各管一段，写进 §2.7bis 防混。

### 1.3 上行：子→父回传（egress）

- **注入防御（P0，批次 1）**：结果包 `<untrusted source="subagent:<agentType>">`（对齐插件/MCP 工具输出策略）；二期加 control-tag 仿冒中和（伪 `<system-reminder>` 反斜杠转义，Claude v2.1.210 同款）。
- **digest 封顶**：`resultMode: 'full' | 'digest'`，缺省 digest：
  - 子最终 assistant 文本 ≤ 8k chars → 原文进父 tool_result；
  - 超限 → 全文落 `sessions/<parent>/subagents/<id>.md`（**按子会话 id 寻址、可覆写**；与备份 `objects/<hash>` 的内容寻址是两回事，勿混），父只收 `摘要行 + 磁盘引用`；摘要=v1 取首段+要点行（**不加模型调用**），**摘要自身硬截 ≤2k chars**（首段与要点行各自截断、溢出以省略号标注）——否则无换行的超长首段会让 digest 路径反超 full 路径的 8k 上界，硬顶公式失守；v2 可选小模型改写（同样受 2k 截断兜底）；
  - 父上下文污染上界公式：**Σ 回传 ≤ max(8k full, 2k digest) × 并发数（8-12）= 64-96k chars 硬顶**（摘要截断后 digest 路径实际 ≤2k × N）——这是 turn 级上下文治理数，进 spec；
  - **落盘文件读取同权包裹**：`sessions/<parent>/subagents/` 前缀下文件的 Read 结果一律按 `source="subagent:<agentType>"` 包 `<untrusted>`（工具侧按路径前缀识别）——该文件是子代理产出的最厚注入面（子读过的网页/外部文件都在其中），不包裹则 digest 落盘成为注入防御的逃逸门。**可读通道（r2b）**：该目录在 home 状态域（cwd 外），父 Read 默认拒工作区外路径——须将 `sessions/<parent>/subagents/` 前缀加为 Read 工具显式放行根（与包裹规则同批落地，二者缺一即断链）。
- **结构化结果（低优先，契约先钉）**：agent 定义 `output: { type: 'json', schema? }`；dispatch 收尾校验失败 → partial + detail。monitor/coordinator 报告消费的正式形态；在 dispatchBatch 之前落地即可。

### 1.4 账本：聚合核算（ledger）

- 数据源 = `subagent.settled` 的 usage（in/out/costUSD）+ `ctxIn`（交接模式注入量）/`ctxOut`（回传量）两个新字段。
- 派生：per-turn / per-session / per-agentType 成本与 token 流向（StatsPage、`volund agents runs`、状态页页头共用）。
- fork 的账本规则：fork 注入的父快照 token 计入子的 `ctxIn`（成本归子），父不重复计——防止 fork 模式把同一内容算两次钱。

**§1 强制点**：dispatcher 单测（fork 快照深拷贝只读 + 体积闸拒绝、digest 阈值分支与摘要 2k 截断、handoff 双闸、ctxIn/ctxOut 计账）；tools 单测（untrusted 包裹存在性 + `subagents/` 前缀 Read 同权包裹）；e2e（并发 8×8k full 回传 + 超长单段触发 digest 路径，回传后父 turn token 有界）。

---

## 2. 多 Agent 协同

### 2.1 结构面：隔离层级

| Tier | 形态 | 写边界 | 进入方式 |
|---|---|---|---|
| **0 · 共享树**（缺省） | 所有 agent 在主 checkout | lock+CAS 串行 + writePaths 契约 | 缺省 |
| **1 · worktree** | `.volund/worktrees/<sessionId>`，产出=patch | 隔离树内自由写；主树仅 apply 点 | `isolation:'worktree'` 显式；**后台代理动文件前自动进**（N8，config 可关，决策点 #5） |
| **2 · detached**（北极星） | supervisor 宿主会话，跨父生命周期 | 同 Tier 1 + PR 化 | 不排期；事件/注册表已为它留位（无 in-turn 假设） |

apply 语义（Tier 1）：patch 经父审批后应用（复用权限链），冲突在 apply 一次暴露；**禁止搬文件**（worktree 救援陷阱教训）。Bash 绕锁问题在 Tier 1 自然消解（隔离树随便跑）。

**基线语义（Tier 1，钉死）**：worktree 基线 = 派发时刻**主树完整工作区状态**（含未提交 tracked 改动〔staged+unstaged〕与 untracked 新文件，尊重 .gitignore），**不是裸 HEAD**——agent 改动几乎全部未提交，`git worktree add <path> HEAD` 看不到父刚写的代码，子会修错基线；实现 = worktree add 后将 `git diff HEAD` apply 进树 + 复制 untracked 清单，派发时一次完成。**嵌套隔离**：父已在 worktree 时，子的基线 = 父隔离树当前工作区状态（同法），不从主树回退取基。

### 2.2 通信面

- **v1 · 请求-响应 + 进度契约**：`dispatch → await → result`；进度=冒泡事件（面板折叠行/follow 已消费）。子不能问父问题（权限通道除外——那是问用户）。
- **v2 · steering（批次 3，随后台化）**：`dispatcher.inject(sessionId, text)`——文本进子消息队列，**子下一 loop 边界**（下一次 provider 请求前）作为追加 user 消息生效；不打断进行中的流。语义=修正航向，不是抢占。实现挂点：Runner 已有 turnAbort/loop 边界，加 pending-injection 队列即可，无新进程机制。**错误语义**：目标已 settled / 已取消 / 未知 sessionId → 类型化错误 `error_subagent_not_active`（不静默入队、不留孤儿消息）。
- **v2 · 通知**：后台代理 settled → TUI 通知行 / Web toast / Mobile push（经 gateway 既有事件通道——通道类型无关盲转，架构成立）。**现状注记（r2 核对）**：三端通知均为零实现（TUI `onRunsChange` 回调未接线、mobile 无任何推送基建），mobile push 依赖 gateway 侧 Web Push 渠道先建，随 detached 批次走。
- **北极星 · SendMessage**：具名代理互发（Claude 同款）；前置=detached 生命周期，不先做。
- **明确不建**：兄弟代理的共享内存黑板（per-turn KV）。理由：文件黑板 + writePaths 已覆盖（repo 的 monitor/coordinator 文化全部走 reports/*.md 文件协作，运行良好）；pi 教训——协作机制留给生态，核心只保最小通信动词（dispatch / inject / cancel）。

### 2.3 编排面：模式库（最小动词原则）

核心动词只加一个：**`dispatchBatch`**（fan-out/fan-in 一次工具调用：`{ items: [{prompt, agentType?, writePaths?}...] }`，共享并发闸与预算账本，结果按序收集）。其余编排=定义与模板，不是新机制：

| 模式 | 载体 | 现状 |
|---|---|---|
| 串行 pipeline | 多次 Task | 已可用 |
| fan-out/fan-in | dispatchBatch | 批次 3-4 |
| review 循环 | 内置 agent 模板：`implementer` + `monitor`（产出 JSON 报告）+ `coordinator`（汇总矩阵） | plans/agents 文化 → 产品化模板，随 `/agents` 管理面交付 |
| map-reduce | writePaths 分区 + dispatchBatch + 父合并（digest 聚合或 patch apply） | 组合能力，无新件 |
| 定时/常驻 | jobs.schedule（§6.4.1a）+ 后台代理 | 北极星（Symphony 型） |

### 2.4 仲裁面：资源与冲突

- **并发闸**：全局 in-flight 上限（默认 8-12，决策点 #3）+ FIFO 排队（pending 态）；排队/锁等待不计预算时间维，但 pending 有饥饿上界：排队超时（缺省 10 分钟，config 可调）→ 类型化终态 `error_subagent_queue_timeout`，不留无限等待位。**现状注记（r2b）**：代码现值 `maxConcurrency=4`（config `[subagent]` 可覆盖）且超限即抛错、无排队；「默认 8-12」为决策点 #3 终值，落地时须带并发对标测试。同批注意 R-G1：dispatcher 现行预算合并是 spread 覆盖（input 可**放宽** default），「逐维只能收紧」是校验项不是现状——实现别沿用现合并逻辑。
- **文件仲裁**：lockfile + old_string CAS（已有）→ Write read-tracking + 内容 hash + 死锁回收（批次 1）→ writePaths 越界拒 + 冲突计数进 settled（批次 3）。
- **预算仲裁**：dispatch 内收紧 / session 聚合（超限=拒新 + 停运行中后台代理 + 类型化终态，对齐 `error_max_budget_usd`）/ daily=backlog。
- **provider 闸**：进程级 in-flight 流上限（含子代理，L7.2）——fan-out 不许打挂父会话的 429 风暴。
- **明确不建**：优先级队列/抢占。理由：用户交互流天然经 provider 闸保护；抢占语义与预算中断（partial 结果）混淆会伤正确性。

**§2 强制点**：并发 harness（双 agent 同文件竞态 / 排队超时 / 取消 / 注入时序四场景，testkit）；worktree 基线含未提交改动的断言 + apply 的 patch-不搬文件断言；dispatchBatch 的预算共账测试。

---

## 3. 文件共享机制（黑板层）

> 文件是 agent 间唯一共享状态载体（黑板）。共享机制 = **读 / 写 / 合并 / 交接 / 回滚**五环节 + 两棵树（主树/worktree）+ **三个写入口**的统一治理。
> 本轮新验证两个缺口：**U1 `/undo` 血统缺口**（备份按 `sessions/<sessionId>/` 分目录，subagent 写文件以子会话 id 归档——父会话 `/undo` 永远回滚不到 subagent 改动，子会话备份目录且无任何访问入口，`storage/index.ts:414,534`）；**U2 Web workbench 裸写**（`writeText`/`writeBytes` 是无锁、无 CAS、无备份的 `writeFile`，`web-server/workbench.ts:223,254`——Web 编辑器与 agent 并发改同文件 = 静默互覆，且绕过全部 mutation 治理）。

### 3.1 读共享（一致性）

- **现状即正确**：原子写（tmp+rename）保证读者永不见撕裂/半写文件；读不设锁（多 agent 并发读天然安全）。
- read-tracking（(session,path)→内容 hash）为 Write expect 提供依据（批次 1，F1）。
- **明确不建**：Read 结果带版本戳、文件变更推送。理由：CAS 已兜底正确性；模型不需要版本号自证——失败-重读路径比版本协商短。

### 3.2 写共享（单树内，四步演进——合并前两轮设计）

1. **串行化**：per-path lockfile，跨进程，持锁写 pid+sessionId（已有）。
2. **CAS**：`old_string` 精确匹配 = 区域级乐观合并（已有，不同区域天然合并/同区域失败重试）+ 快照升级为内容 hash（F2，消同毫秒盲区）。
3. **lost-update 检测**：Write 补 `expect=last-read hash`（F1），失配 → changed-since-read；保留显式 force。
4. **死锁回收**：pid liveness + 锁龄双条件抢占（F4）。
5. **无先前读的写语义**（与 F1 同批钉死）：覆写**已存在**路径必须有本会话的 read 记录（expect 缺省取 last-read hash），无记录 → `changed-since-read` 拒（对齐 Claude「Write 前必 Read」纪律）；**新建**（路径不存在）放行。判定在持锁后进行——两个 agent 同时新建同路径时锁串行化，后到者判定时路径已存在且无读记录 → 拒，消除"双写新文件静默互覆"。

### 3.3 三个写入口统一（本轮核心新增）

| 入口 | 现状 | 治理 |
|---|---|---|
| A · agent 工具（Write/Edit/MultiEdit） | 全闸（锁+CAS+备份+undo） | 基准 |
| B · Bash | 全绕（尽力而为：Bash 后失效 read-cache；Tier 1 worktree 内自然消解） | 已设计 |
| C · **Web workbench**（U2） | **裸 `writeFile`** | **修复：写路径复用 mutateFiles 管线**（提炼 storage/tools 的公共 mutation 端口——现状两侧各持一份私有锁实现〔storage 内部 `acquireFileLock` **未导出** + tools 的 `acquireMutationLock`〕，同 `.volundlock` 约定故互斥语义兼容，端口提炼时统一导出）；Web 编辑器保存 = 第四个工具语义，同锁同备份同 undo。**会话归属（钉死）**：workbench 写入的 sessionId = `hub.active?.id`（与 changes/undo 端点同源；embedded 模式下即 TUI 当前活动会话，hub 经 `attachActive` 跟随激活切换）；无活动会话时保存拒绝并提示。配合 U1 归 lineage 根，web 编辑与 agent 改动落同一 manifest——Web changes 视图、TUI `/undo` 双向可见；不引入独立 web 会话命名空间，杜绝"备份散落无人能 undo 的临时 session 目录"的 U1 复发 |

**U1 修复**：`mutateFiles` 的 sessionId 参数改传 **lineage 根会话 id**（或备份落根会话目录 + record 带 lineage 标注；嵌套子代理〔子派孙〕同样归到同一根，`depth` 只做展示）。`/undo` 语义升级为"回滚本会话树"：父 + 全部子代理 + worktree apply 的备份 batch 进同一 manifest，**每次 /undo 仍弹一个 batch（一次工具执行的改动），按全局逆序逐次撤销**——不是一次调用撤全树，面板展示剩余 batch 预览。undoStep 已取锁（`storage/index.ts:548`），锁文件约定与 tools 侧一致（`.volundlock`），冲突安全现成。

### 3.4 合并与交接

- **同树并发**：字符串 CAS 自然合并；同区域失败方 re-Read 重试；不做自动 3-way merge（LLM 带意图重试 > 无意图文本合并，已钉）。
- **跨树（worktree→主树）**：patch 经审批 apply，冲突一次暴露；**禁止搬文件**（worktree 救援陷阱教训）；apply 走 mutateFiles 管线（同锁同备份）。
- **worktree 写的备份归属（r2b）**：隔离树**内部**写不进 lineage 根 manifest——batch 标记 `isolationTier`，`/undo` 跳过（撤销树内写=向已清理的 `.volund/worktrees/<sessionId>/` 路径恢复，无意义且会重建垃圾目录）；只有 **apply 到主树的 patch** 入根 manifest——撤销 apply 即止，树内中间态随 worktree 生命周期整体丢弃（树快照本身即它的"备份"）。
- **agent 间文件交接**：靠编排顺序（父串行派发）或文件存在性检查；**明确不建** wait-for-file 原语——agent 不是守护进程，等待语义交给编排层（dispatchBatch 收集屏障）。
- **黑板约定**：不建共享 KV/内存黑板；`reports/*.md` 文化 + writePaths 分区即约定（pi 最小化 + repo 文化已验证）。

### 3.5 可观测与治理

- **锁表视图**：谁持哪个路径、等待多久（`/subagents` 面板 + Web SubagentsPage 共用）。**数据源（r2b 修正）**：lock 文件只暴露**持有者**（pid+sessionId，等待方不落盘、只在进程内重试）——持有者来自 lock 文件扫描，**等待者与等待时长来自 dispatcher 运行注册表**（§6.2 数据端口同源），两源拼接成完整锁表。现状注记（r2 核对）：TUI 面板已有（SUBAGENTS-UI-r1），Web 页面与其数据面（dispatcher 运行注册表导出到 web-server）尚不存在，随 §6.2 批次建。
- **热点文件指标**：per-path 冲突率（settled.conflicts 聚合）→ 高热路径反馈给 planner 型父 agent 优化 writePaths 划分（E3 扩展）。
- **审计闭环**：JSONL + 备份全量已有；U1 修复后 `/undo` 覆盖全树，审计-回滚-重放三链闭合。

### 3.6 已知残留（接受项）

目录级操作（rm/mkdir 经 Bash/workbench）无文件级锁——一期接受：文件级治理为主，目录级风险由沙箱+权限把守；记录在案防"以为有锁"。

**§3 强制点**：workbench 写入走锁的并发单测；`/undo` 跨 lineage（父+子混合改动）e2e；双 agent 同文件竞态 harness（含 Bash 与 Web 入口三方竞态变体）。

## 4. 数据契约汇总（一处看全）

> **事件落地约束（r2 核对）**：`subagent.dispatched` / `subagent.settled` 是**新事件类型**（现仓 EVENT_NAMES 26 种中无 subagent.*）——须走事件新增同步点全清单（EVENT_NAMES 白名单 + payload schema 注册 + verify-event-schemas CI + 3 个硬编码计数守卫 + resume 尾部 20-turn 窗口 prepend 会话级事件）；ctxIn/ctxOut 属既有契约字段描述，无此负担。现状进度=子会话事件经 EventBus.forward 冒泡，envelope 带 `parentTurnId`/`parentDepth` 标签（`packages/core/src/event-bus.ts:53`）。

```yaml
# Task input（批次 3 终态）
{ prompt, agentType?, budget?,          # budget 逐维只能收紧（R-G1）
  writePaths?, fork?, handoff?,          # 交接：fork / 糖
  resultMode?, runInBackground?, isolation? }

# agent 定义 frontmatter（N3 富化后）
{ name, description, model?,             # model 白名单按 scope（R-C3）
  tools?, disallowedTools?,               # 白/黑名单互补，只可收紧
  mcp?, skills?, permissionMode?,         # 只可收窄
  maxTurns?, context.maxTokens?,          # 只可小于父
  output?: {type,schema}, memory? }       # 结构化结果 / 只读缺省

# subagent.dispatched payload
{ sessionId, parentSessionId, parentTurnId, agentType?, depth,
  isolationTier, fork, writePaths?, budget,
  promptDigest, ctxIn }                   # ctxIn=交接注入 token

# subagent.settled payload
{ sessionId, status, usage{in,out,costUSD}, ctxOut,   # ctxOut=回传 token
  toolCalls, durationMs, conflicts?, detail? }

# inject（steering，v2）
dispatcher.inject(sessionId, text) -> queued; 子下一 loop 边界生效
#   目标已 settled/取消/未知 -> error_subagent_not_active
```

## 5. 与路线图的对齐

批次 1：§1.3 untrusted + §1.4 事件字段 + **§3.2 hash/死锁回收/无先前读写语义 + §3.3 U1 备份归血统根** + **§6.1 现存缺陷修复（U3 混流过滤 / U4 审批归属——今天的 bug，不等新事件）** · 批次 2：运行行 ctx% + follow（§1.2 压力信号）+ **§3.5 锁表视图** + **§3.3 U2 workbench 统一入口（提前——Web 编辑器丢改动是用户可感 bug，且与 U1 同批 mutation 端口提炼，合并落地省一遍基建）** + **§6.2 Web SubagentsPage + TUI 通知行接线** · 批次 3：fork/handoff + digest 封顶（含摘要 2k 截断、落盘 Read 同权包裹与放行根）+ runInBackground + steering + writePaths + dispatchBatch 骨架 + **Web settled toast（依赖 subagent.settled 事件落地）+ subagent.* hook 广播接通（§7.3）** · 批次 4：schema 富化批（N3）+ **插件 agent 注册（§7.1，随 N3 同批）** + worktree 自动隔离（含基线语义与备份归属）+ 结构化结果 · 北极星：detached + SendMessage + jobs 编排 + Mobile push。与 review-r1 §4 路线图咬合。

---

## 6. UI 面（TUI / Web / Mobile）

> r2 新增：评审发现前五节只覆盖 TUI 视角；Web/Mobile 两端经代码核对（2026-09-16）要么零实现、要么存在**今天就发作的现存缺陷**（派一个子代理，Web/Mobile 聊天流立刻混入子代理的工具行与流式文本）。本节治理 subagent 的可见性：进度、归属、通知、取消、undo。
> 现状基线：`subagent.*` 事件尚不存在（§4 约束）；进度=子会话事件冒泡，envelope 带 `parentTurnId`/`parentDepth`；TUI 已过滤冒泡（`packages/ui/src/app.tsx:429`），Web/Mobile 均未过滤；TUI `/subagents` 面板已有（列表/取消/详情），Web 无任何 subagent 页面与数据面，Mobile 无 subagent 视图、无取消入口、无推送基建（全目录零 Notification/serviceWorker 引用）。

### 6.1 现存缺陷（先修 bug，再做功能）

| # | 缺陷 | 证据 | 修复 |
|---|---|---|---|
| **U3 · 子事件混流** | Web/Mobile 聊天 reducer 不读 `parentTurnId`/`parentDepth`（Envelope 类型未声明该二字段），子代理的 tool 行与流式文本无差别混入主聊天流 | `apps/web/src/lib/session-stream.ts:89-98`、`apps/mobile/src/lib/chat.ts:137-249`；TUI 对照过滤在 `packages/ui/src/app.tsx:429-432` | 两端 Envelope 类型补声明 + reducer `parentDepth > 0 → 过滤`（对齐 TUI）；顺带 Task 工具行折叠（子代理聚合为一行） |
| **U4 · 审批无归属** | 子代理权限请求确实进共享队列、Web/Mobile 能清卡（复用 `PermissionPromptController`），但卡面只有 `{approvable, spec, toolName}`，分不清主代理与子代理/agentType | `packages/web-server/src/session-hub.ts:44-49`；移动站同构（经 gateway 盲转） | `permission.request` view 帧补 `lineage: { sessionId, agentType?, parentTurnId }`；三端卡面加「子代理 · \<agentType\>」徽标 |
| U1/U2 · undo 盲区 | Web changes 视图与 `/undo` 只查 `hub.active.id`，子代理备份落子会话目录不可见；workbench 裸写无归属 | §3.3 已修 | U1 归 lineage 根 + U2 归属 `hub.active?.id` 后，Web changes / TUI `/undo` 双向覆盖全树（含 worktree apply） |

### 6.2 目标面（随批次交付）

| 面 | TUI（基线） | Web | Mobile |
|---|---|---|---|
| 运行面板 | `/subagents` 已有 | SubagentsPage 新建：路由 + `GET /api/v1/subagents`（dispatcher `#runs` 注册表导出到 web-server，现为进程内私有）+ SSE 增量；复用 SubagentsPanelController 契约 | 会话页内嵌只读运行行 + 取消（`dispatcher.cancel` 经 remote-link RPC 透出，现仅 TUI 面板可达） |
| 运行行 ctx% | §1.2 压力信号 | 面板行 + Task 折叠行同字段 | 同 |
| Task 折叠行 | 已有（冒泡过滤） | ChatPanel tool-row 升级：折叠 + prompt 摘要 + ctx% | ChatView 工具 chip 升级（现仅尾部 4 条平铺） |
| settled 通知 | 通知行（`onRunsChange` 接线，现未接） | toast | push 依赖 gateway Web Push 基建先建，随 detached 批次 |
| 锁表视图 | `/subagents` 分区（§3.5） | SubagentsPage 分区（同数据端口） | 不做（屏小，锁表是诊断面） |
| undo 全树 | `/undo` 逐 batch（§3.3） | ChangesPage 自动受益（同 manifest） | 不做 |

**§6 强制点**：web/mobile reducer 的 parentDepth 过滤单测；审批卡 lineage 徽标三端快照；SubagentsPage 数据面 e2e（dispatch → SSE 增量 → cancel 全链）。

---

## 7. 插件扩展面（subagent × plugin）

> r2b 新增。原则延续 pi 教训：**扩展开在定义层与观察层，不开在机制层**——核心动词集（dispatch / inject / cancel）与安全管线（untrusted 包裹 / digest / 锁与 CAS）不是插件扩展点。
> 现状地基（2026-09-16 核对）：子会话 runner 复用同一 `createRunner` 闭包——插件工具（`plugin:<名>:` 前缀、进统一权限链）、插件 prompt fragments（composer 每会话注入）、preToolUse/postToolUse hook 管线**已天然覆盖子代理**，无需新建；agent 定义装载只有 user/project 两层文件目录（`agent-registry.ts`），插件没有程序化注册面；HOOK_EVENTS 16 种中无 subagent 相关。

### 7.1 定义层（主扩展面：插件注册 agent）

- **注册**：bridge 新增 `agents.register`（对齐 tools.register 形态），插件携带 agent 定义集进 AgentDefinitionRegistry，scope='plugin'。
- **覆盖序**：plugin 先扫（最低优先级）→ user → project，同名后扫覆盖（维持 r13-G3 既有语义）——插件定义被用户/项目覆盖是特性不是冲突。
- **校验同构**：插件来源不豁免任何收窄规则——`tools` 白名单对父 registry（**含全部插件工具**）收紧、model 白名单 R-C3、permissionMode/skills/mcp 只可收窄；N3 富化字段同契约。
- **trusted 度**：plugin scope 正文不包 `<untrusted>`（对齐插件 prompts 语义——用户显式安装/批准即信任）；project scope 维持包裹。
- **编排模板即插件**：§2.3 的 review 循环（implementer/monitor/coordinator）与 map-reduce 模板 = 内置插件携带的 agent 定义集 + 使用文档，零新机制；`/agents` 管理面对 user/project/plugin 三来源统一展示。

### 7.2 工具层（已具备，钉语义）

- 插件工具自动进子工具宇宙（toolRegistrySnapshot 继承父 registry）；agent 定义 `tools` 白名单可点名 `plugin:<名>:` 工具（allowedTools 校验全集 = registry 含插件）。
- **不做** per-audience 工具注册（「只给子代理、不给主会话」）——全局面 + agent 白名单收窄已覆盖，双向注册面是纯复杂度。

### 7.3 观察层（随事件解锁）

- HOOK_EVENTS 新增 `subagent.dispatched` / `subagent.settled`（随事件落地接通宿主广播面）——插件可做：通知渠道（桌面/webhook）、账本聚合（usage/conflicts 契约见 §4）、护栏（settled 超阈值告警）。
- 插件 hook 对子代理工具调用**现已生效**（dispatchHook 在子 executor 内），veto/rewrite 语义与主会话一致。

### 7.4 明确不开放

- 插件自定义调度器、新通信原语、隔离后端（机制层）；
- 插件改 digest 阈值、untrusted 包裹、锁/CAS 行为（安全边界）；
- 插件直读 dispatcher 内存注册表（走 §6.2 数据端口，与 Web/Mobile 同源同权）。

**§7 强制点**：覆盖序测试（plugin < user < project 同名三层）；插件 agent 的白名单/收窄校验同构测试；settled hook 事件 e2e（插件收到 payload 与 §4 契约一致）。
