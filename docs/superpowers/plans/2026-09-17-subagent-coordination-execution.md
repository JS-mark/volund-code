# 多 Agent 协同与上下文管控 · 实现执行计划（2026-09-17）

> **状态**：待开工。批次 0（spec）未落地前，代码批次一律不动工。
> **输入**：[2026-09-13-subagent-context-coordination-design.md](./2026-09-13-subagent-context-coordination-design.md)（r2/r2b 合并设计，下称「设计 §x.y」）——它是 spec §2.7bis 的直接蓝本；上游链路：[coordination-report](./2026-09-11-subagent-coordination-report.md)（现状核对）→ [master-plan](./2026-09-13-subagent-governance-master-plan.md)（L0-L7）→ [review-r1](./2026-09-13-subagent-plan-review.md)（业界对照修订）。
> **编号**：新启 **SAG**（SubAgent Governance）序列，不复用 REM。
> **执行方式**：并行 worktree + 每 SAG 一分支一 PR；验收走 [agents 监督体系](./agents/README.md)；每项完成后回写 [16-capability-traceability](../specs/2026-07-31-volund-code-design/16-capability-traceability.md)。
> **现状核对**（2026-09-17 复核，全部与设计断言一致）：EVENT_NAMES=26 无 subagent.\*；HOOK_EVENTS=15；dispatcher `maxConcurrency=4`/`maxDepth` 硬钳 ≤3/预算 spread 合并（`packages/subagent/src/index.ts:98-99,220`）；TUI 过滤在 `packages/ui/src/app.tsx:438`，Web/Mobile reducer 无 parentDepth 分支；`WebPermissionRequest` 仅 `{approvable,spec,toolName}`（`packages/web-server/src/session-hub.ts:44-49`）；storage `acquireFileLock` 未导出（`packages/storage/src/index.ts:987`）vs tools `acquireMutationLock`（`packages/tools/src/index.ts:202`），同 `.volundlock` 约定；workbench `writeText/writeBytes` 裸 writeFile（`packages/web-server/src/workbench.ts:223,254`）；备份按子会话归档（`storage/index.ts:436`）；config reload 重建 dispatcher 清史（`apps/cli/src/runtime.ts:813`）。

---

## 0. 执行约定（所有 SAG 通用）

1. **分支**：`sag-<NN>`，基于最新 `main` 建出；**PR 前必须 `git fetch origin && git rebase origin/main`**。
2. **提交**：`git commit -s`；提交信息 `SAG-NN: <摘要>`。
3. **PR body 必含**：设计文档章节引用（§x.y）/ spec 章节引用（§2.7bis 落地后）/ 强制点测试清单 / 完成状态（done | partial | blocked）。
4. **spec 纪律**：批次 0（SAG-01）合并后 `docs/superpowers/specs/**` 即冻结；实现发现契约与现实冲突 → 停 blocked 报 A/B 出口，不自行裁决、不改 spec。
5. **冲突面纪律**：`packages/tools/src/index.ts` 与 `packages/storage/src/index.ts` 是单一大文件——同一并行波次内只允许一个 SAG 修改其中任一文件（批次内已用波次标注串行链）。
6. **验收**：
   - 汇报全绿前必须 `TURBO_FORCE=true pnpm test`（turbo 缓存会掩盖失败）+ 受影响包 typecheck；禁止跳过既有测试。
   - 改 `packages/*` 后必须先 `pnpm build` 再跑下游测试（exports 指向 dist，否则静默跑旧代码）。
   - 触及 bundle/TUI 渲染路径的项，除单测外须 pty 实测 TUI 起得来（react-reconciler prod 重定向会让 ink 无声挂起）。
   - 新增事件类型走 8 处同步点全清单（schema 文件 / EVENT_NAMES+计数注释 / EVENT_SCHEMAS 注册 / events.test.ts 计数+fixture / event-bus.test.ts 计数 / spec §2.3 表 / APPENDIX-D 表+计数 / verify-event-schemas 硬编码断言），并检查 resume 尾部 20-turn 窗口是否须 prepend 会话级事件。
7. **人在环**：Mark 自己 merge PR；CI/冲突问题一句话汇报，修到全绿为止。

## 决策点（开工前待拍板，仅余 2 项）

| # | 决策点 | 影响项 | 建议 |
|---|---|---|---|
| D-a | 并发默认值：8 还是 12（现 4，超限即抛错无排队） | SAG-23 | **8**（农忙期稳；排队落地后默认值不再是压力阀，对标测试两档都跑） |
| D-b | N8 worktree 自动隔离：默认开（config 可关）还是 opt-in | SAG-32 | **opt-in**（review-r1 倾向；volund 先求稳，后台代理跑顺一批再翻默认） |

~~budget 保留只许收紧 / runInBackground 进批次 3 / fork 随批次 3~~：设计 §2.4/§5 已拍板，按推荐值执行。

## 工作包总览

| 批次 | SAG | 主题 | 落点 | 波次 |
|---|---|---|---|---|
| 0 | SAG-01 | spec §2.7bis + 附录同步（docs-only，冻结契约） | specs/** | 单独先行 |
| 1 | SAG-02 | N1：Task 结果 `<untrusted>` 包裹 | tools/index.ts | 波 B（tools 链②） |
| 1 | SAG-03 | subagent.dispatched/settled 事件对 + 注册表重建 + reload 保史 + 僵尸 interrupted | shared/subagent/core/runtime | 波 A |
| 1 | SAG-04 | G1：budget 逐维只能收紧校验 | subagent | 波 A |
| 1 | SAG-05 | §3.2：Write expect/hash 快照/死锁回收/无先前读写语义 | tools/index.ts + storage | 波 A（tools 链①） |
| 1 | SAG-06 | U1：备份归 lineage 根 + /undo 全树逐 batch | storage + tools + ui | 波 B（tools 链③，SAG-05 后） |
| 1 | SAG-07 | U3：Web/Mobile reducer parentDepth 过滤 + Envelope 声明 + Task 折叠行 | shared/web/mobile | 波 A |
| 1 | SAG-08 | U4：permission.request lineage + 三端审批徽标 | app-runtime/web-server/ui/web/mobile | 波 A |
| 1 | SAG-09 | G3：agent 定义 allowedTools 超父集拒绝接线 | subagent/agent-registry | 波 A |
| 2 | SAG-10 | §1.2：ctxUsagePct 压力信号 + follow 模式 | subagent/ui | ✅ |
| 2 | SAG-11 | §3.5：锁表视图（持有者=lock 扫描 + 等待者=dispatcher 注册表） | subagent/ui | ✅ |
| 2 | SAG-12 | U2：mutation 公共端口提炼 + workbench 统一入口（归属 hub.active） | storage/tools/web-server | 独波（双大文件） |
| 2 | SAG-13 | §6.2：Web SubagentsPage + 数据面 + TUI 通知行接线 + Mobile 只读运行行/取消 | web-server/web/ui/mobile | 依赖 SAG-03 |
| 2 | SAG-14 | B4：MachineEvent 血统字段 + `volund agents list/runs` | core/cli | ✅ |
| 2 | SAG-15 | N7 前半：内置只读 agentType explore/plan | subagent | ✅ |
| 2 | SAG-16 | /agents 管理面 + r 键热重载 | ui/subagent | ✅ |
| 3 | SAG-20 | fork 模式（深拷贝快照 + 60% 体积闸 + ctxIn 归子） | subagent | 波 A |
| 3 | SAG-21 | handoff 糖（files ≤512KB/总量 ≤2MB 双闸 + brief 槽位） | subagent/composer | 波 A（与 SAG-20 同人改 dispatch input，串行） |
| 3 | SAG-22 | digest 封顶（8k/2k 截断 + 落盘 + Read 放行根与同权包裹） | subagent/tools | 波 A（tools 链） |
| 3 | SAG-23 | runInBackground + FIFO 排队 + pending 态 + 排队超时 + 并发默认 D-a | subagent/runtime | 波 A，批内最大项 |
| 3 | SAG-24 | steering：dispatcher.inject + error_subagent_not_active | subagent/runner | 依赖 SAG-23 |
| 3 | SAG-25 | writePaths 契约（越界拒 + 冲突计数进 settled） | subagent/tools | 波 B（tools 链，SAG-22 后） |
| 3 | SAG-26 | dispatchBatch 骨架（fan-out/fan-in + 共享闸与预算共账） | subagent/tools | 依赖 SAG-23/25 |
| 3 | SAG-27 | Web settled toast + §7.3 subagent.\* hook 广播 + control-tag 中和 | web/plugin-runtime/tools | 依赖 SAG-03/13 |
| 3 | SAG-28 | R2 派发门禁（Task permissionSpec 接权限链）+ L5.1 孤儿 shell 收编 | tools/runtime | 波 B，SAG-23 前必须合 |
| 4 | SAG-30 | N3：agent schema 富化批（disallowedTools/mcp/skills/permissionMode/context.maxTokens/memory） | shared/subagent | ✅ |
| 4 | SAG-31 | §7.1：插件 agents.register（覆盖序 plugin<user<project + 校验同构） | plugin-runtime/subagent | 依赖 SAG-30 |
| 4 | SAG-32 | N8：worktree 自动隔离（基线=主树完整工作区 + 嵌套 + apply 走 mutateFiles + 备份 isolationTier） | subagent/storage/tools | 依赖 SAG-06/23；D-b 拍板 |
| 4 | SAG-33 | 结构化结果 output:{type:'json',schema} → partial+detail | subagent/shared | ✅ |
| 4 | SAG-34 | 会话预算聚合（拒新 + 停后台 + error_max_budget_usd；默认关） | subagent | 依赖 SAG-23 |
| 4 | SAG-35 | model 白名单按 scope + 沙箱深度递进 + W13 hook ctx | subagent/app-runtime/plugin-runtime | ✅ |
| 4 | SAG-36 | 长尾批：telemetry span / prompt 32k 上限 / maxDepth config 化 / toolCallMax 退役 / memory 只读默认 | 分散小项 | ✅ |
| 4 | SAG-37 | review 循环模板（implementer/monitor/coordinator = 内置插件 agent 集） | plugins | 依赖 SAG-31/33 |
| 北极星 | — | detached supervisor / SendMessage / jobs 编排 / Mobile push / subagent resume / agent view 全功能 | 不排期，形态就绪即启 | — |

> 依赖关系：批次 2 全部依赖 SAG-03 事件对；批次 3 的 toast/hook（SAG-27）依赖 SAG-03 + SAG-13 数据面；SAG-32 依赖 SAG-06 的 lineage manifest 与 SAG-23 的后台生命周期；writePaths 与 fork/handoff 同改 Task input schema，必须同批（已同批，波次串行）。

## 批次 0 任务卡

### SAG-01 · spec §2.7bis 落地（docs-only）
- 契约：设计文档全文（§0-§7）→ 冻结契约。
- 范围：`02-agent-loop.md` 新增 §2.7bis（上下文管控三口一门 + 协同四面 + 数据契约 §4 yaml 全量）+ §2.3 事件表加 subagent.dispatched/settled 两行；`APPENDIX-D-event-payloads.md` 字段表 + 计数 26→28；`APPENDIX-C-config-schema.md` [subagent] 新键（queue_timeout_ms / session_budget / max_concurrent 新默认 / worktree 开关）；`04-tools-permissions.md`（Write expect 与无先前读写语义、`sessions/<parent>/subagents/` Read 放行根 + 同权包裹、workbench 写治理）；`22-web-console.md`（SubagentsPage + workbench 管线化 + 审批 lineage）；`19-plugin-kernel.md`（§7 扩展面：agents.register + 两个 subagent hook + §7.4 不开放清单）；`07-terminal-ui.md`（/subagents ctx%/锁表分区、/undo 全树语义）；`11-cli-commands.md`（volund agents 命令组）；`16-capability-traceability.md` 挂行。
- 验收：`pnpm --filter docs test`（vitepress 构建 + verify-event-schemas 对 §2.3 新行仍绿——本 PR 同步把计数断言 26→28）；三处「N 种事件」计数同步。
- 边界：只改 specs/**；一个 PR 落完，合并即冻结。

## 批次 1 任务卡（地基 + 现存 bug）

> 波次：A = SAG-03/04/05/07/08/09 并行；B = SAG-02（tools 链②）+ SAG-06（tools 链③，须 SAG-05 合并后切出）。

### SAG-02 · N1：Task 结果 untrusted 包裹（P0）
- 契约：设计 §1.3；review-r1 N1。
- 范围：`packages/tools/src/index.ts` Task invoke 返回处——`dispatched.text` 包 `<untrusted source="subagent:<agentType>">`（对齐插件/MCP 工具输出策略；内置 agentType 用 `subagent:builtin`）。
- 验收：tools 单测——包裹存在性 + source 属性正确；既有 Task 测试全绿。
- 注：control-tag 仿冒中和（伪 `<system-reminder>` 转义）在 SAG-27 同批做，不在此项。

### SAG-03 · subagent.dispatched / subagent.settled 事件对（全批地基）
- 契约：设计 §1.4/§4 + master L0；事件清单 8 处同步点（执行约定 §6）。
- 范围：dispatcher 发射点（dispatch 入口/收尾）；payload 按设计 §4（含 ctxIn/ctxOut 字段位——fork/handoff 未落地前 ctxIn 计 prompt 估算值）；注册表 = 内存 live + JSONL 重放重建，dispatched 无 settled → `interrupted`（B3）；修 `runtime.ts:813` reload 清史（重建后从 JSONL 回填）；检查 resume 20-turn 窗口 prepend 语义。
- 验收：8 处清单 CI 全绿；重放重建单测（含 crash 后 interrupted 分支）；reload 后运行史保留单测。
- 边界：不改 UI 消费侧（批次 2 的活）。

### SAG-04 · G1：budget 逐维只能收紧
- 契约：设计 §2.4 R-G1 注记——「逐维只能收紧」是校验项不是现状，**不得沿用现 spread 合并**。
- 范围：dispatcher 校验 input.budget 每维 ≤ defaultBudget 对应维，超限 → 类型化拒绝（注册错误码，走 error-codes registry）；未传的维继承 default。
- 验收：单测——模型传 `costUSDMax:1000` 抬限被拒；逐维收紧放行；错误码字面量扫描 CI 不红。

### SAG-05 · §3.2 文件层四步（F1/F2/F4 + 无先前读）
- 契约：设计 §3.2 步骤 2-5 + §3 强制点。
- 范围：session 级 read-tracking（(session,path)→内容 hash）；Write 补 `expect=last-read hash` 失配 → changed-since-read（保留显式 force）；mtime+size 快照升级为内容 hash；`.volundlock` 死锁回收（pid liveness + 锁龄双条件抢占）；无先前读写语义——覆写已存在路径须本会话 read 记录，新建放行，**判定在持锁后**（双 agent 同新建同路径串行后后者拒）。
- 验收：tools 单测（expect 失配/新建放行/无读记录覆写拒/持锁后判定竞态）；死锁回收单测（死 pid + 老锁被抢、活 pid 不抢）。
- 冲突面：tools/index.ts 波次①。

### SAG-06 · U1：备份归血统根 + /undo 全树
- 契约：设计 §3.3 U1 钉死段。
- 范围：`mutateFiles` sessionId 改传 **lineage 根会话 id**（嵌套子代理同归一根，depth 只做展示）；/undo 语义=「回滚本会话树」——父+全部子代理的备份 batch 进同一 manifest，**每次 /undo 仍弹一个 batch，全局逆序**；面板展示剩余 batch 预览。
- 验收：e2e——父+子混合改动后 /undo 逐 batch 逆序撤销全覆盖；storage/tools 单测。
- 冲突面：依赖 SAG-05 合并后切出（同改 mutateFiles 一带）。

### SAG-07 · U3：Web/Mobile 混流过滤（现存 bug）
- 契约：设计 §6.1 U3 + §6 强制点。
- 范围：Envelope 类型补 `parentTurnId?`/`parentDepth?` 声明（shared）；`apps/web/src/lib/session-stream.ts` 与 `apps/mobile/src/lib/chat.ts` reducer 加 `parentDepth>0 → 过滤` 分支（对齐 TUI `app.tsx:438`）；顺带 Task 工具行折叠（子代理聚合为一行）。
- 验收：两端 reducer parentDepth 过滤单测；TUI 行为不回归。

### SAG-08 · U4：审批归属 lineage（现存 bug）
- 契约：设计 §6.1 U4 + §6 强制点。
- 范围：`permission.request` view 帧补 `lineage: { sessionId, agentType?, parentTurnId }`（`session-hub.ts:44-49` 投影面扩展，gateway 盲转天然透传）；TUI/Web/Mobile 三端审批卡加「子代理 · \<agentType\>」徽标。
- 验收：三端卡面徽标快照测试；主代理请求无徽标回归。

### SAG-09 · G3：allowedTools 超父集拒绝
- 契约：review-r1 批次 1 遗留 P0；设计 §7.1 校验同构的前置。
- 范围：`agent-registry.ts` discover 接线 allowedTools 校验——定义 tools 超父 registry 全集（含插件工具）→ 拒绝装载并明示。
- 验收：单测——超集拒/子集放/插件工具点名放行。

## 批次 2 任务卡（可见性）

### SAG-10 · ctxUsagePct 压力信号 + follow
- 契约：设计 §1.2/§6.2。
- 范围：`SubagentRunEntry` 增 `ctxUsagePct`（live，来自子 state）；TUI 运行行显示 `ctx 78%`；follow 模式=面板详情实时 tail 子代理转录（数据=冒泡事件聚合，无新通道）。
- 验收：面板单测 + pty 实测运行行刷新。

### SAG-11 · 锁表视图
- 契约：设计 §3.5（r2b 数据源修正：持有者=lock 文件扫描，等待者+时长=dispatcher 运行注册表，两源拼接）。
- 范围：dispatcher 注册表导出等待面；TUI `/subagents` 面板加分区。
- 验收：双 agent 争同文件时锁表显示持有者+等待者。

### SAG-12 · U2：mutation 公共端口 + workbench 统一入口
- 契约：设计 §3.3 入口 C + §3 强制点。
- 范围：提炼 storage/tools 的公共 mutation 端口（`acquireFileLock` 导出统一 + `acquireMutationLock` 合并，同 `.volundlock` 约定）；workbench `writeText/writeBytes` 改走该管线（锁+CAS+备份+undo 全闸）；**会话归属 = `hub.active?.id`**（与 changes/undo 端点同源），无活动会话保存拒绝并提示。
- 验收：workbench 写入走锁的并发单测；Web 编辑与 agent 并发改同文件不互覆；undo/changes 双向可见。
- 冲突面：独波（同触 storage+tools 双大文件）。

### SAG-13 · Web SubagentsPage + 通知接线
- 契约：设计 §6.2 + §6 强制点。
- 范围：`GET /api/v1/subagents`（dispatcher #runs 注册表导出到 web-server + SSE 增量）+ cancel 端点透出；SubagentsPage 新建（复用 SubagentsPanelController 契约）；TUI settled 通知行接线（`onRunsChange` 现未接）；Mobile 会话页内嵌只读运行行 + 取消经 remote-link RPC。
- 验收：dispatch → SSE 增量 → cancel 全链 e2e；TUI 通知行 pty 实测。

### SAG-14 · MachineEvent 血统 + volund agents
- 契约：master L0.3/L6；`--json` v1 加可选字段（向后兼容）。
- 范围：MachineEvent 加可选 `parentDepth`/`parentSessionId`；`volund agents list`（定义枚举+信任域+tools 白名单）+ `volund agents runs [session]`（JSONL 派生运行史）。
- 验收：--json 冒烟（子代理事件带血统标记）；两命令单测。
- 注：**bare prompt 派发契约**——新增子命令必须同步 commandUsage，否则被静默吞成 prompt。

### SAG-15 · 内置只读 agentType explore/plan
- 契约：review-r1 N7 前半。
- 范围：内置 explore/plan 定义（只读=免权限门+免 writePaths）；注册进 BUILTIN_AGENT_TYPES 路径。
- 验收：dispatch explore 不触发权限门；写工具不在其工具宇宙。

### SAG-16 · /agents 管理面 + 热重载
- 契约：review-r1 L6/L2.1。
- 范围：TUI `/agents` 面板（定义列表/来源域/白名单）；r 键重扫两目录（对齐 skills 面板）；或 dispatch 前重扫（开销可忽略，二选一在 PR 记录）。
- 验收：改定义文件后 r 键生效单测 + pty 实测。

## 批次 3 任务卡（协同协议）

### SAG-20 · fork 模式
- 契约：设计 §1.1 模式 B + §1.4 fork 账本规则。
- 范围：Task input `fork: true`；dispatcher 冻结快照=**structuredClone 深拷贝**（浅拷贝共享引用会被父压缩/redaction 追溯改写）；**体积闸**=快照预估 token > 子 context.maxTokens 60% → 类型化拒绝（提示改用模式 A）；fork 注入 token 计子 ctxIn，父不重复计。
- 验收：dispatcher 单测（深拷贝只读性 + 体积闸拒绝）；账本单测（不双计）。

### SAG-21 · handoff 糖
- 契约：设计 §1.1 模式 C。
- 范围：Task input `handoff: { files?, brief? }`；files 由 dispatcher 预 Read 注入子首条上下文（计子预算），复用 AttachmentStore 权限根（cwd 内）；**双闸**：单文件 ≤512KB 且总量 ≤2MB，超限拒绝并指明超限项；brief 进 composer 独立槽位。
- 验收：双闸单测（单文件超限/总量超限/放行）。

### SAG-22 · digest 封顶 + 落盘 + 同权包裹
- 契约：设计 §1.3 digest 全段 + §1 强制点。
- 范围：`resultMode: 'full'|'digest'` 缺省 digest；≤8k chars 原文进 tool_result；超限落 `sessions/<parent>/subagents/<id>.md`（**按子会话 id 寻址可覆写，与 objects/\<hash\> 内容寻址勿混**），父收摘要行+磁盘引用；摘要 v1=首段+要点行，**自身硬截 ≤2k chars**（首段与要点行各自截断+省略号标注），不加模型调用；`sessions/<parent>/subagents/` 前缀加为 Read 工具**显式放行根**且该前缀下 Read 结果一律按 `source="subagent:<agentType>"` 包 `<untrusted>`——放行根与包裹同批落地，缺一即断链。
- 验收：dispatcher 单测（阈值分支 + 摘要 2k 截断 + 无换行超长首段不反超 8k 上界）；tools 单测（前缀 Read 包裹存在性）；e2e（8×8k 并发 full 回传后父 turn token 有界 ≤64-96k 硬顶公式）。

### SAG-23 · runInBackground + 并发排队
- 契约：设计 §2.2 v2/§2.4 并发闸；review-r1 R1（后台化为核心里程碑）。
- 范围：Task input `runInBackground`；并发超限改 FIFO 排队 + `pending` 态（废现抛错）；排队/锁等待不计预算时间维；排队超时（缺省 10 分钟 config 可调）→ 类型化终态 `error_subagent_queue_timeout`；父 abort 清队；默认值按 D-a 拍板落地 + 并发对标测试。
- 验收：testkit 并发 harness 四场景（双 agent 同文件竞态/排队超时/取消/注入时序）；429 风暴不连锁（provider 闸联动）。
- 注：事件/注册表不留 in-turn 假设（detached 留位）。

### SAG-24 · steering inject
- 契约：设计 §2.2 v2。
- 范围：`dispatcher.inject(sessionId, text)` → 子消息队列，**子下一 loop 边界**作为追加 user 消息生效，不打断进行中流；目标已 settled/取消/未知 → `error_subagent_not_active` 类型化错误（不静默入队）。
- 验收：单测（loop 边界生效时序 + 三类非活跃目标的类型化错误）。

### SAG-25 · writePaths 契约
- 契约：设计 §2.1 Tier 0/§2.4。
- 范围：Task input `writePaths` glob 数组；工具层越界即拒（对齐 tools 白名单只能收紧）；冲突计数进 `subagent.settled.conflicts`。
- 验收：越界拒单测 + 冲突计数进 settled payload。

### SAG-26 · dispatchBatch 骨架
- 契约：设计 §2.3。
- 范围：`{ items: [{prompt, agentType?, writePaths?}...] }` 一次调用 fan-out/fan-in；共享并发闸与预算账本；结果按序收集。
- 验收：预算共账测试（batch 内 N 项合计受 session 上限约束）；按序收集不错位。

### SAG-27 · settled toast + subagent.\* hook 广播 + control-tag 中和
- 契约：设计 §7.3 + §7 强制点；review-r1 N1 二期。
- 范围：HOOK_EVENTS 加 `subagent.dispatched`/`subagent.settled`（15→17）接通宿主广播面；Web settled toast；Task 结果 control-tag 仿冒中和（伪 `<system-reminder>` 反斜杠转义）。
- 验收：插件收 settled hook e2e（payload 与设计 §4 契约一致）；中和单测（仿冒标签被转义、真 system-reminder 不误伤）。

### SAG-28 · R2 派发门禁 + 孤儿 shell 收编
- 契约：review-r1 R2（弃 config 分类法，走既有权限/hook 面）；master L5.1。
- 范围：Task `permissionSpec()` 接权限链（project scope 定义派发问询走 permissions.toml 规则，卡面带归属+预算摘要）；dispatch finally 收编子代理后台 shell（killAll 按 sessionId 前缀过滤）——**必须在 SAG-23 后台化合并前落地**（后台代理夭折留下的 shell 不再随父 turn 收尾）。
- 验收：门禁单测（project 定义触发问询/user 定义放行）；孤儿 shell 收编 e2e。

## 批次 4 任务卡（治理深化）

### SAG-30 · N3 schema 富化批
- 契约：review-r1 N3；设计 §4 frontmatter 契约。
- 范围：agent 定义 frontmatter 一次扩批——`disallowedTools`（白/黑名单互补只可收紧）/`mcp: [server]`（只可收紧）/`skills`/`permissionMode`（只可收窄）/`context.maxTokens`（只可小于父，dispatcher 建会话取 min）/`memory`（只读缺省）。
- 验收：逐字段收窄校验单测；超宽定义拒绝。

### SAG-31 · §7.1 插件 agents.register
- 契约：设计 §7.1 + §7 强制点。
- 范围：bridge 新增 `agents.register`（对齐 tools.register）；覆盖序 plugin 先扫（最低）→ user → project 同名后扫覆盖；校验同构（插件来源不豁免任何收窄规则）；plugin scope 正文不包 untrusted，project 维持包裹。
- 验收：三层同名覆盖序测试；插件 agent 白名单/收窄校验同构测试。

### SAG-32 · N8 worktree 自动隔离
- 契约：设计 §2.1 Tier 1 全段（基线语义/嵌套/备份归属）+ §2 强制点。
- 范围：`.volund/worktrees/<sessionId>`；**基线 = 派发时刻主树完整工作区状态**（含未提交 tracked 改动 + untracked，尊重 .gitignore——worktree add 后 `git diff HEAD` apply 进树 + 复制 untracked 清单），父已在 worktree 时从父树取基；后台代理动文件前自动进（D-b 拍板默认档）；apply 经父审批走 mutateFiles 管线（同锁同备份，**禁止搬文件**）；树内写 batch 标 `isolationTier` 不进根 manifest，只有 apply 入根 manifest。
- 验收：基线含未提交改动断言；apply patch-不搬文件断言；/undo 跳过树内 batch、可撤 apply。

### SAG-33 · 结构化结果
- 契约：设计 §1.3 末段。
- 范围：agent 定义 `output: { type:'json', schema? }`；dispatch 收尾校验失败 → partial + detail。
- 验收：schema 校验通过/失败两路单测。

### SAG-34 · 会话预算聚合
- 契约：设计 §2.4 预算仲裁；review-r1 修订（执行语义补强 + 默认关）。
- 范围：`[subagent] session_budget`（默认关，文档推荐 $20）；settled 累计；超限 = 拒新 + **停运行中后台代理** + 类型化终态（对齐 `error_max_budget_usd`）。
- 验收：三执行语义各自的单测。

### SAG-35 · model 白名单 + 沙箱递进 + W13
- 契约：master L2.2/L2.3/L2.4；设计 §7.1 校验同构引用。
- 范围：project scope 定义 model 只能选 config 已声明别名（R-C3）；`depth>0` sandbox 档位不可高于父且深度+1 至少收紧一档；hook ctx 加 `depth`/`isSubagent`。
- 验收：三子项各自单测。

### SAG-36 · 长尾批
- 契约：master L7.1/A3/G5/L1.4/L3.5。
- 范围：telemetry subagent span（trace_id 自 parentTurnId 派生）；dispatch prompt 硬上限 32k chars（超限拒并引导 handoff.files）；maxDepth 放开硬钳改 config 可调；退役 toolCallMax（归 maxTurns）；TaskTool.timeoutMs 与 timeMsMax 联动；subagent memory 默认只读（user scope 可设 read-write）。
- 验收：逐项小单测；附录 C 键同步。

### SAG-37 · review 循环模板插件
- 契约：设计 §2.3/§7.1（编排模板即插件，零新机制）。
- 范围：内置插件携带 implementer + monitor（JSON 报告）+ coordinator（汇总矩阵）agent 定义集 + 使用文档；`/agents` 面三来源统一展示。
- 验收：模板插件装载 + 一次 review 循环 e2e（digest 聚合回父）。

## 监控与状态

- 每个 SAG 完成即按 [agents/README.md](./agents/README.md) spawn 监控 agent 出 `reports/SAG-NN-<date>.md`。
- 主 agent 每 ≥5 份报告或任一 blocked 跑一轮汇总；lessons-learned 追加经验。
- PR 合并后回写 16-capability-traceability 对应行 + 本计划首行状态。
- 进度记录：批次 0 ⬜ / 批次 1 ⬜(0/8) / 批次 2 ⬜(0/7) / 批次 3 ⬜(0/9) / 批次 4 ⬜(0/8)。
