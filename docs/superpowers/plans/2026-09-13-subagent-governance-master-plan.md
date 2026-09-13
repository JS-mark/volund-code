# Subagent 治理管控总体方案（Master Plan）

> ⚠️ 本文档已被 [2026-09-13-subagent-plan-review.md](./2026-09-13-subagent-plan-review.md)（Review-r1：自审 + 业界对照）修订——路线图与决策点以 review 文档 §4/§5 为准，本文其余部分仍有效。

> 2026-09-13 · 前置文档：[2026-09-11-subagent-coordination-report.md](./2026-09-11-subagent-coordination-report.md)（现状核对，全端覆盖，断言带 file:line）
> 本文 = 该报告 §4 目标设计的全量展开 + 上下文管理 + 协同模式 + **遗漏盘点**。
> 定位：spec 修订（02-agent-loop §2.7 增补 + 新章 §2.7bis）的蓝本；落地前按批次拆 plan。

---

## Part 1 · 遗漏盘点（"还有什么没想到的"）

> ★ = 本轮代码核对新验证的事实；○ = 此前报告已覆盖、此处归位；◇ = 设计/生态层缺口。

### A. 上下文管理（此前四端报告未系统设计——本轮补齐）

| # | 发现 | 依据 |
|---|---|---|
| A1★ | **无上下文交接契约**：子代理裸启动——只有模型写的 prompt + agent 正文，无任务简报/相关文件/约束的结构化交接。模型只能在 prompt 里内联，父上下文被重复内容撑大 | `subagent/index.ts:209`（createSession 仅传 cwd/maxTokens/registry/lineage） |
| A2★ | **结果回传无上限**：`lastAssistantText` 全文进父 turn 的 tool_result，长报告直接污染父上下文；无摘要/截断/落盘引用选项 | `index.ts:293` |
| A3★ | **prompt 无尺寸上限**：模型可写超长 dispatch prompt（存储侧截 2000，执行侧不截） | `index.ts:148` vs `:222` |
| A4★ | **per-agentType 上下文策略缺失**：child 继承父 `contextBudget.maxTokens`，agent 定义 schema 无 context 字段 | `index.ts:212` + `agent-schema.ts` |
| A5○ | 子代理压缩**已有**：`SlidingWindowPolicy` 在 createRunner 内按 Runner 构建，child 同样生效（此项是健康项，方案只补策略差异化） | `runtime.ts:1066,1503` |
| A6◇ | **子代理与 memory 系统边界未定义**：memory 工具归 orchestration 域，被 `[plugins] builtin_disabled` 门控——subagent 是否可读写长期记忆没有显式策略 | `runtime.ts:1369` |

### B. 生命周期与故障

| # | 发现 | 依据 |
|---|---|---|
| B1★ | **孤儿后台 shell**：`BackgroundShells` 是进程级共享实例，子代理可用 Bash `runInBackground`；但子会话**不 emit `session.ended`**，其后台 shell 只在主会话结束时 killAll——父会话继续运行期间，死掉的 subagent 留下的 shell 持续占用 | `runtime.ts:931` + `session-controller.ts:363` |
| B2★ | **agent 定义无热重载**：冷启动 `discover()` 一次；对比 skills 每次面板 `r` 键重扫。新增/修改定义须重启进程 | `runtime.ts:928` vs `:1133` |
| B3◇ | **僵尸运行标记**：`subagent.dispatched` 落盘后若进程 crash 无对应 settled，重放重建时须标 `interrupted` 而非永远 running | 依赖 B1 事件落地后生效 |
| B4◇ | 重试语义未定义：failed 后模型自行 re-dispatch，无幂等/去重/退避；error 文案可引导（"重试前先 Read"模式已在文件层验证有效） | — |

### C. 信任与安全

| # | 发现 | 依据 |
|---|---|---|
| C1◇ | **派发门禁缺失**：Task `permissionSpec()` 为空 + 无策略层——"项目级 untrusted agent 要跑"或"单次派发预算超阈值"都不问询 | `tools/index.ts:673` |
| C2◇ | **沙箱不随深度递进**：spec W13 的 hook 降档思路未延伸到 sandbox——depth 越深应越严（或至少感知 depth） | §2.7 W13 未落地 |
| C3◇ | **untrusted 定义可绑定任意 provider/model**：project 级 agent（仓库作者可控）的 frontmatter `model` 无白名单——数据外发面 + 成本面双重暴露 | `agent-schema.ts:13` |
| C4◇ | **插件贡献 agent 定义的生态位缺失**：插件已能贡献 tools/prompt fragments，agents 是自然扩展点（`plugin.contribute.agents`），信任语义（用户装插件≈user scope）待定 | `runtime.ts:1383` 一带 |
| C5◇ | 审计留存策略：JSONL 即审计源，但留存期/导出/脱敏（prompt 可能含密钥）未定 | — |

### D. 协同模式

| # | 发现 | 依据 |
|---|---|---|
| D1◇ | **通信是单向一次性的**：dispatch → await → result。无父中途 steering、无子提问、无进度契约（事件流是副产品不是契约） | `index.ts:229` |
| D2◇ | **无结构化结果契约**：结果 = 最后一条 assistant 文本的字符串；per-agentType 输出 schema（JSON 校验回传）不存在——下游机器消费只能再解析 | `index.ts:293` |
| D3◇ | **编排模式库缺失**：fan-out/fan-in、pipeline、review 循环（repo 已有 monitor/coordinator 文化，全是提示词约定无工具支撑）；无 dispatchBatch | `plans/agents/` |
| D4◇ | runInBackground + 完成通知（含 Mobile push）不在册 | — |
| D5○ | 文件黑板协同：锁 + CAS 已隐式工作，writePaths 契约化在册 | 报告 §4.6 |

### E. 可观测性深化

| # | 发现 | 依据 |
|---|---|---|
| E1◇ | **无 trace 关联**：sessionId lineage ≠ tracing；telemetry 无 subagent span、无 trace_id 贯穿父子——跨 agent 时序分析无锚点 | `telemetry` 包无 subagent 埋点 |
| E2◇ | **无 follow 模式**：无法实时 tail 一个运行中 subagent 的转录（面板只有状态行；JSONL 数据其实已在） | — |
| E3◇ | 无指标面板：成功率/重试率/冲突率/成本 per agentType 随事件可得，无聚合出口 | — |

### F. 工程与配额

| # | 发现 | 依据 |
|---|---|---|
| F1◇ | **fan-out 429 风暴**：4 并发 subagent 各自流式请求 + 父会话，router fallback 会放大重试；无进程级 provider 请求并发闸 | — |
| F2◇ | 配额只有 per-dispatch（有）与 per-session（已设计）；**日级/全局配额缺失** | — |
| F3◇ | testkit 无多 agent 并发场景 harness（两 agent 同文件竞态的确定性测试） | — |
| F4◇ | 进程内 CPU 阻塞：工具同步计算卡住事件循环即卡全部 4 个并发 subagent；worker/subprocess runner 形态（远期） | — |

---

## Part 2 · 完整方案（七层框架）

### L0 · 数据与契约地基

1. `subagent.dispatched` / `subagent.settled` 事件对，发父总线落 JSONL（shell.background_* 同构）；payload 含 usage/toolCalls/durationMs/conflicts/detail。
2. 注册表 = 内存 live + JSONL 重放重建；`dispatched` 无 `settled` → 标 `interrupted`（B3）。
3. 血统贯通四端协议：`--json` MachineEvent 加可选 `parentDepth`/`parentSessionId`；Web/Mobile reducer 以 `parentDepth>0` 为折叠分支。
4. 配置 reload 保留运行史（修 `runtime.ts:808`）。

### L1 · 资源管控

1. **预算三层钳制**：per-dispatch（模型只能在 default 内收紧，逐维 min）→ per-session（`[subagent] session_budget`，settled 累计，超限拒新）→ per-day/global（`[subagent] daily_budget`，缺省关）。成本数据源 = settled 事件。
2. **并发排队**：超限 FIFO 排队 + `pending` 态（规格 r13-D1 本义）；父 abort 清队；锁等待/排队时间不计 budget 时间维。
3. **派发门禁**（C1）：`[subagent] dispatch_policy` = `auto` | `ask_project_agents`（project scope 定义须确认）| `ask_above_budget`（阈值 X）。实现挂 Task permissionSpec + 权限链，问询卡带归属与预算摘要。
4. TaskTool.timeoutMs 与生效 timeMsMax 联动；退役 toolCallMax（归 maxTurns）。

### L2 · 信任与安全

1. 定义装载：`allowedTools` 接线（超父集拒绝）+ **热重载**（每次 dispatch 前重扫两目录，开销可忽略；或 `/agents` 面板 r 键同 skills）。
2. **model 白名单按 scope**：project 级定义只能选 config 已声明过的 provider/model 别名；user/plugin scope 放开（C3）。
3. 沙箱随深度递进：`depth>0` 起 sandbox 档位不可高于父、深度+1 至少收紧一档（细则随 W13 一并落）。
4. W13：hook ctx 加 `depth`/`isSubagent`。
5. 审计：JSONL 留存策略 + prompt 脱敏（复用 §4.4.235 sanitize/detectSecret 管线）进 dispatched 事件前处理。

### L3 · 上下文管理（A 系列落法）

1. **交接契约**：Task input 加可选 `handoff`：`{ brief?: string, files?: string[], constraints?: string[] }`。`files` 由 dispatcher 在子会话启动前预 Read 注入为首条 user 上下文（选择性交接——父不用把文件内容复制进 prompt，token 从父挪到子）；`brief`/`constraints` 进独立 prompt 槽位（composer priority 与 skill 同级）。
2. **结果回传契约**：settled 前对 `lastAssistantText` 做——超阈值（如 8k chars）→ 提示模型自摘要重跑不可取，改为：落 `sessions/<parent>/subagents/<id>.md` + 父 tool_result 只回 `摘要行 + 文件路径`（复用 AttachmentStore 内容寻址）。`resultMode: 'full' | 'digest'`，缺省 digest。
3. **prompt 上限**：dispatch prompt 硬上限（如 32k chars）超限即拒——引导模型用 handoff.files。
4. **per-agentType 上下文策略**：agent 定义 frontmatter 加 `context: { maxTokens?: number }`（只能小于父值）；dispatcher 建会话时取 min。
5. memory 边界：subagent 默认只读 memory（记忆检索安全、写入仅顶层会话）；agent 定义可显式放开 `memory: 'read-write'`（仅 user scope 可设）。

### L4 · 多 agent 协同（D 系列 + 文件协同归位）

1. **通信演进**：一期保持单向一次性（简单即对），补"进度契约"——settled 前的冒泡事件即进度（面板折叠行已消费）；二期可选 steering：父对运行中子代理 `inject(correction)`（排队到子下一 loop 边界，语义=追加 user 消息）。
2. **结构化结果**：agent 定义加 `output: { type: 'json', schema?: <inline JSON Schema> }`；dispatch 收尾校验失败 → partial + 明确 detail。配合 monitor/coordinator 报告消费。
3. **编排模式库**：Task 加 `dispatchBatch`（同 prompt 模板 × N 上下文数组，fan-out/fan-in 一次工具调用完成，共享并发闸）+ `/agents new` 模板（review-loop、parallel-implement 等 repo 文化固化）。
4. **文件协同**（报告 §4.6 全量）：Write read-tracking + 内容 hash 快照 + 死锁回收 + Bash 失效 read-cache + writePaths 契约 + 冲突计数进 settled。
5. **worktree 隔离**：`isolation: 'worktree'`（独立立项）；`runInBackground` Task + 完成通知（TUI 通知行 / Mobile push 经 gateway）。

### L5 · 生命周期与故障

1. 孤儿后台 shell：dispatch finally 收编子代理 shell（killAll(sessionId 前缀过滤) 或子代理禁用 runInBackground 一期先拒）。
2. 取消语义保持 interrupt 链；排队项取消 = 出队。
3. 重试指引：failed dispatch 的 tool error 文案带"re-Read 后重试 / 检查 writePaths 冲突"提示。
4. 僵尸标记（B3）随 L0。

### L6 · 四端呈现（报告 §4.1-4.4 全量归位）

TUI 折叠行 + 面板增强（pending/进度/分区/冲突/聚合/`/agents` 定义管理页含热重载）；Web SubagentsPage + API + 聊天流折叠修复 + StatsPage 成本段；Mobile 折叠条 + 审批归属 + push 通知 + 二期取消；CLI `--json` 血统字段 + `volund agents list/runs`。**follow 模式**：面板/Web 详情页实时 tail 子代理转录（数据 = 冒泡事件，视图层聚合）。

### L7 · 工程保障

1. telemetry：subagent span（trace_id = parentTurnId 派生，遵循 W9 uuidv7），E1/E3 指标出口。
2. provider 并发闸：进程级 in-flight 流上限（含 subagent），超限排队——防 429 风暴连锁。
3. testkit 并发 harness：双 agent 同文件竞态 / 排队 / 取消 / 僵尸重放四类确定性场景。
4. 远期：worker 线程 runner 形态（CPU 密集工具不卡并发）。

---

## Part 3 · 路线图（合并）

| 批次 | 内容 | 新增依赖说明 |
|---|---|---|
| **1 地基** | L0 全部 + L1.1 预算钳制 + L2.1 装载校验/热重载 + 文件层 F1/F2/F4（Write expect / hash / 死锁回收）+ L5.1 孤儿 shell | 互独立可并行；全部小-中改 |
| **2 端统一** | L6 四端 + L0.3 血统协议 | 依赖批次 1 事件对 |
| **3 协同协议** | L1.2 排队 + L1.3 派发门禁 + L3 上下文契约（handoff/结果回传/prompt 上限）+ L4.4 writePaths + L4.2 结构化结果 | handoff 与 writePaths 同改 Task schema 宜同批 |
| **4 治理深化** | L1.1 会话/日配额 + L2.2-2.5（model 白名单/沙箱递进/W13/审计脱敏）+ L5.4 + L7.1 telemetry | — |
| **独立立项** | worktree 隔离、runInBackground+push、dispatchBatch/编排模板、worker runner | 各自成期 |

## Part 4 · 决策点（累计，待拍板）

1. Task `budget` 入参：保留只许收紧（推荐）或删除。
2. 会话/日配额默认值（建议 session $20 缺省开、daily 缺省关）。
3. 泄漏口径：四端统一折叠呈现（推荐）。
4. 结果回传 `digest` 阈值（建议 8k chars）与 `resultMode` 缺省值。
5. `handoff.files` 预读注入是否计子代理 token 预算（建议计）。
6. 派发门禁缺省档（建议 `auto`，`ask_project_agents` 可选）。
7. subagent memory 默认只读是否接受。
8. `--json` v1 加可选字段（推荐）。
9. worktree / runInBackground / dispatchBatch 的立项顺序。
