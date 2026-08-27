> ↩ [返回索引 (README)](./README.md) · ← [上一章: §14 Onboarding](./14-onboarding.md) · [下一章: §16 能力追踪](./16-capability-traceability.md) →

---

## §15 自适应运行时调优（Adaptive Runtime Tuning）

> **状态：EXPERIMENTAL / PARTIAL。** 本节只定义白名单内运行时数值参数的有界调优，不修改代码、测试、配置制品或发布产物。代码/制品变更属于 [§18 受控自我开发 / 变更流水线](./18-self-development.md)，当前尚未交付。
>
> **当前实现事实（T1b）**：`EvolutionEngine`、`EvolutionStore`、规则评估和 `volund evolution show|rollback` 已存在；引擎与生产组装缺省关闭，只有严格 own-property boolean `[evolution].enabled = true` 才会在创建 Runner 时读取通过 strict decoder、context bounds 与整快照约束的 tuning。配置缺失或显式 `false` 时保持内置默认且不读取 tuning persistence；不可读、语法错误或类型错误按 §8.3/C.1 阻止 Runner 启动，同样不会读取 tuning。T1b 起，新写入记录为携带 `recordId` + per-namespace `sequence` 的 flat V2，双文件 append 由跨进程锁与 `.evolution-txn.json` journal 保护并在启动/读取时恢复；`volund doctor` 增加 tuning journal 健康提示。`observe()`、`validate()`、tuning Memory、Router/Retry/Tool-timeout 应用、确认 UI 和调优 telemetry 均未接入生产调用链，因此当前仍不是闭环。

### 15.1 定义与命名边界

| 名称 | 作用 | 不包含 |
|---|---|---|
| **Adaptive Runtime Tuning** | 观察运行信号，在静态白名单和步长限制内建议/验证数值参数 | 改代码、生成 commit、运行自选命令、审批或发布 |
| **Self-Development / Change Pipeline** | §18 的候选代码/制品开发、独立验证和人工批准 | 普通数值 tuning |
| **普通 Agent 编码** | 用户指令下使用 Read/Edit/Write/Bash | 自动调优或自我开发闭环 |

不得把普通 Edit/Bash 使用、Memory 写入、Skill 激活、Plugin/Hook 扩展或 subagent 分工称为本节“自适应调优”。本节沿用现有文件名和 CLI namespace `evolution` 只为兼容；产品文案应优先使用 **Adaptive Runtime Tuning**。

### 15.2 目标与永久边界

目标：

- 根据本机、本用户的聚合运行信号，小步优化低风险体验/效率参数。
- 每个建议、应用、验证和回滚都可审计、可解释、可关闭。
- 先 shadow 验证收益，再允许用户对单个 namespace 显式 opt-in 应用。
- 任何结果缺失、样本不足、验证不确定或安全 guard 不完整时保持默认值。

永久非目标：

- **永不调优安全参数**：Sandbox profile/tier、Permission 决策顺序和 allow/deny、安全命令规则、untrusted wrapping、Hook trust/priority、Auth/secret、Plugin trust、自动 Skill、Memory permission、审批、CI/release/signing/publish 等全部永久排除。
- 不跨用户聚合、不上传 prompt/代码/secret，不用远端训练替代本地授权。
- 不让模型、Plugin、Skill、候选项目内容或动态配置扩充可调参数白名单。
- 不把 tuning audit 当成 §18 的候选证据、approval 或 release gate。

### 15.3 当前实现状态

下表以仓库生产组装为准；类型、测试或存储类存在，不代表调用链已闭合。

| 子能力 | 当前状态 | 证据与限制 |
|---|---|---|
| 静态 defaults / namespace / 参数 allowlist | **Implemented** | `packages/core/src/evolution-engine.ts` 定义 context/router/retry/tool-timeout defaults 和静态参数集合 |
| 规则评估 | **Implemented, not observed in production** | `#evaluate()` 使用固定阈值规则；不是模型驱动、ML 或自主假设生成 |
| 步长 clamp / 累计偏离确认接口 / worsen rollback | **Implemented as engine logic** | 只有调用 `propose()` / `validate()` 才生效；生产未注入确认 handler，也未调用验证 |
| JSONL tuning store / audit / rollback | **T1b hardened (journal-backed)** | 新写 flat V2（`recordId` + per-namespace `sequence`）；strict/bounded decoder、legacy-v0/v1 provenance、validated rollback、跨进程锁与 `.evolution-txn.json` crash recovery、doctor 提示已落地；文件**内容**每步 fsync，但新文件创建的跨断电持久性受 Node 无可移植目录 fsync 限制（Windows 必须如实披露，POSIX 可在部署层补加） |
| Runner 读取 tuning | **Partial, explicit opt-in only** | 缺省不读取；只有 `[evolution].enabled = true` 才读取经整快照校验的 context `compaction_threshold`、`target_ratio`、`keep_recent`；`summary_keep_recent` 未传入 ContextPolicy；bounds 未冻结的其他 namespace 永远不读取持久值 |
| Observation | **Not wired** | `EvolutionEngine.observe()` 无生产 caller，真实运行信号没有进入采样窗口 |
| Validation | **Not wired** | `EvolutionEngine.validate()` 无生产 caller，生产不存在调参后的对照验证/自动回滚闭环 |
| Tuning Memory | **Existing-unwired, outside §15 target** | `TuningMemoryStore.write()` 存在但无生产 caller；自然语言 lesson/prompt recall 不是数值 runtime tuning |
| Human confirmation | **Not wired** | engine 默认 `confirm` 为拒绝；CLI/TUI 没有累计偏离确认流程 |
| Runtime tuning telemetry | **Not shipped** | 不能把本节历史事件名称当作已注册/已发出的事件 schema |
| Default safety posture | **T0 implemented** | engine 缺省 disabled；production 只接受严格 boolean `true`。缺失/`false` 使用默认；坏配置、I/O 和错类型阻止 Runner 启动；所有失败分支都不读取 tuning persistence |

因此当前只有用户显式设置严格 boolean `true` 时，Runner 才可能读取通过 V1/legacy-v0 strict decoder 和安全 envelope 的 context JSONL 值并注入三项 ContextPolicy 参数；任何未知投影、坏值或整快照约束失败都回到完整 defaults，不能部分 merge。当前生产运行不会自行产生新的 observation、proposal、validation 或 tuning Memory。`volund evolution show|rollback` 始终保留为显式维护入口，不会开启自动 observe/validate。文档和 UI 不得把这一状态描述成“自动优化中”或“闭环已开启”。

### 15.4 目标运行模式与默认值

后续实现必须提供三个语义明确的模式；T0 目前只冻结了严格 boolean `enabled` 兼容开关，shadow/apply 的新 config key 只有在 schema/附录/迁移同时落地后才成为支持接口：

| 模式 | 行为 | 目标默认 |
|---|---|---|
| **off** | 使用内置默认；不观察、不建议、不应用持久 tuning | **新安装和未显式迁移用户的默认** |
| **shadow** | 收集去敏聚合信号并运行规则/验证，只记录“本可建议”的结果；不改变 Runner 参数 | 首次 opt-in 唯一允许模式 |
| **apply** | 在 shadow evidence gate 通过后，对用户显式选择的 namespace 应用低风险小步调整 | 非默认；每个 namespace 单独 opt-in |

**自动应用的前置 evidence gate** 至少包括：同版本 baseline、足够样本、确定性规则、预算内变更、下一窗口验证、可复现 rollback、audit 完整和独立评审。该 gate 尚未落地；T0 的 legacy `enabled = true` 只允许显式应用已有 context tuning，不会开启 observation 或 validation，也不得被解释为完整 apply 模式。缺省和下列显式设置都使用内置默认：

```toml
[evolution]
enabled = false
```

缺省 off 已由 engine、production composition、严格 config schema 与回归测试共同强制。后续仍须另行引入 shadow/apply 的注册 schema、doctor 提示和升级说明；不能借用 legacy boolean 绕过这些 gate。

### 15.5 目标闭环：Observe → Hypothesize → Adjust/Shadow → Validate

这是**目标架构**，不是当前生产状态：

1. **Observe**：能力节点只提交 schema 化、去敏的计数/比率；窗口达到最小样本前不评估。
2. **Hypothesize**：v1 由版本化的确定性规则评估。当前 `#evaluate()` 就是规则骨架，不是“模型主导”。
3. **Adjust/Shadow**：off 不处理；shadow 只写建议 evidence；apply 才能在 allowlist、步长、累计偏离和用户 namespace opt-in 下持久化新值。
4. **Validate**：在下一独立窗口与调整前 baseline 比较；worsen 或 inconclusive 都回到 previous/default，连续失败后冻结参数。

未来若引入模型生成 hypothesis，模型输出也只能是 untrusted proposal，必须通过同一静态 allowlist、确定性 clamp、证据门和 rollback；这不改变本节是 runtime tuning、也不自动获得 §18 权限。

### 15.6 Namespace 与接线矩阵

| Namespace | 白名单参数 | 目标信号 | 当前生产接线 | 最早可应用条件 |
|---|---|---|---|---|
| **context** | `compaction_threshold` / `target_ratio` / `keep_recent` / `summary_keep_recent` | 压缩后重复率、context-length 错误、立即重压缩、近期内容丢失 | **部分读取；无 observe/validate** | shadow E2E + ContextPolicy 四参数完整接线 + 恶化回滚证据 |
| **router** | `cooldown_ms` / `max_attempts`（最终白名单需重新安全评审） | fallback 成功/失败、用户中断、成本 | **未应用** | Router 边界测试、provider 失败注入、成本/可用性双 guard |
| **retry** | `max_retries` / `backoff_factor`（最终白名单需重新安全评审） | retry 成功/失败、额外 token/时间 | **未应用** | Retry 去重/计费证据、预算上限、无重复副作用证明 |
| **tool-timeout** | default/per-tool timeout，硬上限 300s | timeout 与用户重试率 | **未应用** | typed tool 级信号、后台任务分离、资源占用 guard |
| **sandbox / permission / hook / auth / trust / release** | **无，永久排除** | 可只做安全观测 | **不得应用** | 不存在解锁阶段；需人工规范/实现变更 |

Router/Retry/Tool-timeout 在状态表中“规则存在”不等于可上线；没有 composition wiring、真实 observation、验证与边界 E2E 时一律保持 off。

#### 15.6.1 T1a context 可信安全 envelope

以下 bounds 在 core 中 deep-frozen 并导出；持久化 projection、proposal clamp 与 storage decoder 必须共同使用同一份定义：

| 参数 | default | min | max | 额外约束 |
|---|---:|---:|---:|---|
| `compaction_threshold` | 0.85 | 0.65 | 0.95 | finite number |
| `target_ratio` | 0.60 | 0.45 | 0.75 | finite number |
| `keep_recent` | 20 | 15 | 25 | integer |
| `summary_keep_recent` | 20 | 15 | 25 | integer |

整快照还必须满足 `target_ratio + 0.10 <= compaction_threshold`。该 envelope 以当前 defaults 和 25% 累计偏离确认边界为基准：`target_ratio` 与两个 recent 参数采用 ±25% 边界，`compaction_threshold` 再按压缩语义收紧到 0.65..0.95，避免接近 0/1 的退化区。任何单项或 cross-field 失败都拒绝**整个 persistence projection**并使用完整 defaults，不能保留其中看似合法的字段。

Router、Retry、Tool-timeout 尚无冻结的可信 bounds；其规则骨架可以保留，但 `values()`、`EvolutionStore.current()` 与 `rollback()` 对这些 namespace 一律 deny-only/defaults。`audit/show` 只能展示通过结构校验的历史；动态 per-tool timeout 记录同样不能进入持久化 apply。

### 15.7 数据面；自然语言 Memory 不属于本闭环

§15 只有一个权威数据面：`~/.volund/tuning/<namespace>.jsonl` 保存结构化 before/after/reason/aggregate signal/action，`audit.jsonl` 提供跨 namespace 视图。T1a 新写记录为 exact flat shape `EvolutionRecordV1 = { schemaVersion: 1, namespace, param, before, after, at, reason, signal, action }`；append 必须先严格校验、sanitize，再 normalize 为 V1。

读取边界采用 bounded streaming decoder：每行最多 16 KiB，reason 最多 1024 UTF-8 bytes，signal 最多 32 个固定格式 key、每个 key 最多 64 bytes，所有数值必须 finite 且在固定上限和 context bounds 内；unknown field/param、namespace 与文件不一致、坏 ISO time、accessor/Proxy、坏 action/signal 一律丢弃并只发固定诊断 code。普通 invalid item 不覆盖之前的合法值；future integer schema 使该 context namespace 的 `current/rollback` 整体 fail-closed，`null`/string version 也绝不降级为 legacy。

无 `schemaVersion` 的 strict legacy-v0 记录与 `schemaVersion:1` 的 V1 记录可作为兼容 current/rollback 输入，但 audit 必须显式标 `provenance = legacy-v0 | v1`，且永远不能作为 T1/T2 evidence；新 append 一律写 flat V2（`{ schemaVersion: 2, recordId: <32 hex>, sequence, namespace, param, before, after, at, reason, signal, action }`），identity（`recordId` 为 16 随机字节的 hex，`sequence` 为 per-namespace 单调计数，从既有 V2 历史的最大值 +1）只在锁内由 store 分配，调用方携带的 identity 一律剥离重分配；namespace 文件内 V2 `sequence` 必须严格递增，回退记录按 `evolution_record_sequence_regression` 丢弃；future integer schema（>2）使该 context namespace 的 `current/rollback` 整体 fail-closed，`null`/string version 也绝不降级为 legacy。

T1b 起双文件 append 采用受保护事务：写前先持久化 `.evolution-txn.json` journal（记录两文件的 pre-size 与 prefix SHA-256、exact record line 与 identity），状态机为 `PREPARED → NAMESPACE_DURABLE → BOTH_DURABLE`，每步 fsync，完成后删除 journal。任何读取或写入先做 recovery：`BOTH_DURABLE` 且两文件尾部逐字节等于 journal 记录的 exact line 时判定 committed（两文件都以 matching `recordId` 携带该记录才可见）；`PREPARED`/`NAMESPACE_DURABLE` 默认 abort——仅在多余字节确实是该事务 record line 的前缀时把两文件截断回 pre-size；任何无法证明的情形（prefix digest 不符、出现外来字节、journal 损坏）把 journal 置为 `RECOVERY_REQUIRED`：文件保持原样，所有 append/rollback 拒绝执行，直到人工移除或修复 `.evolution-txn.json`。并发 writer 由 `<root>/.evolution-lock.json` 跨进程互斥（持有者 pid 已死的 stale lock 可接管）；该锁是本地协调原语，不是安全边界。诚实边界：文件**内容**的每步 fsync 保证了上述恢复语义，但新文件**创建**（journal、lock、首个 JSONL）的跨断电持久性依赖目录 fsync，Node 无可移植 API，Windows 部署必须披露该限制；T1b 的 audit 数据可作本机诊断，用作 T1/T2 promotion evidence 仍需独立评审。

仓库虽然已有未接线的 `TuningMemoryStore.write()`，但“把自然语言偏好/教训写入 Memory 再召回 prompt”会改变模型行为，不是白名单数值参数 tuning，**不属于 §15 的 Observe/Adjust/Validate pipeline 或交付阶段**。若未来需要该功能，必须在 §6.12 下另立产品、permission、sanitize、preWrite、prompt-injection 和用户审计契约；它不得作为 §15 的输入、输出、evidence 或启用前置，也永远不能授权工具、修改 §18 policy、提供 approval 或覆盖用户指令。当前生产既没有该写入 caller，也没有专用召回路径。

### 15.8 调整与验证护栏

| 护栏 | 目标强制语义 | 当前实现情况 |
|---|---|---|
| 静态白名单 | 参数集合由 builtin code 定义；config/模型只能缩小 | engine 已有静态集合；仍需 composition/boundary tests |
| 单步上限 | 数值变更不超过固定小步与相对 10% 的更严格者 | engine 已 clamp |
| 值域上限 | 每个参数有绝对 min/max；tool timeout ≤ 300s | **context T1a 已冻结并强制**；其他 namespace 未冻结并保持 persisted apply deny-only |
| 累计偏离 | 超阈值不静默应用；要求显式确认或恢复/冻结 | engine 有 callback，但生产未接 UI，默认拒绝 |
| 下一窗口验证 | worsen 自动 rollback；inconclusive 也不保留 | engine 有 `validate()`，生产未调用 |
| 连续失败冻结 | 默认 3 次 worsen 后停止该参数 | engine 有骨架；生产未形成窗口 |
| 审计 | proposal/application/rollback/freeze 都绑定规则/信号版本 | store 部分可用；事件/schema 尚未交付 |
| 持久化投影 | persistence 是不可信边界；invalid/future 不得部分应用 | **T1a 已实现**：exact allowlist、finite/bounds/integer、whole-snapshot cross constraint、strict versioned decoder |
| 默认关闭 | 缺省 off；先 shadow，apply 需 evidence gate + opt-in | **T0 已实现**：缺省/false 不读 tuning；坏配置/错类型停止 Runner；只有严格 boolean true 才进入已验证 context 值读取路径 |

值域、步长、样本窗口和 worsen 判定必须是可信版本化 policy，不接受项目文件、Plugin、Skill 或模型动态扩宽。任何安全相关参数即使用户要求也不能通过 tuning API 修改；它们只能走正常人工配置/RFC/代码评审/发布流程。

### 15.9 人机控制面

当前已支持：

```text
volund evolution show [--namespace <name>] [--since <time>] [--json]
volund evolution rollback [--namespace <name>] [--to <time>]
```

这两个命令只查看/回滚本地 tuning store，不证明 observation 或 validation 已运行。历史文档里的 `enable`、`disable`、dashboard 或累计偏离弹窗不是当前 CLI 能力。

目标控制面必须额外做到：

- 明示 off/shadow/apply 和每个 namespace 的状态，不能只显示模糊“enabled”。
- 显示当前值、builtin default、来源、样本量、规则版本、最近验证和 rollback 原因。
- 从 shadow 升级 apply 需要明确 opt-in；安全 namespace 不出现启用入口。
- 关闭后立即使用 builtin defaults；是否保留历史 audit 与“应用值”分离，关闭不能删审计。

### 15.10 隐私、审计与故障语义

- Signal 只能包含聚合数值和版本标识，不保存 prompt、代码、文件内容、secret、完整 URL 或个人标识。
- sanitize 必须在持久化边界执行；sanitize/append/schema 失败 → 本窗口丢弃并保持默认，不允许“先应用后补日志”。
- Store 截断、未知 schema、非有限数值、越界值或 clock 回退 → 忽略该记录、发本地诊断并保持 previous/default。
- Network telemetry 仍遵守 §8 默认本地、显式 opt-in；本节不能自行开启 OTel。
- 任何拟新增 tuning 事件必须先进入 §2.3/附录 D 的 event schema registry 并通过事件验证；当前不得声称已发出。

### 15.11 Evidence gates 与交付顺序

1. **T0 — Truth/default（已交付 default-off 核心）**：engine/production 缺省 off，配置 schema/附录一致，回归测试证明 disabled 零 persistence read/write；文档不声称闭环。
2. **T1a — Trusted context persistence（已交付）**：冻结 context bounds/cross constraint；core 对 untrusted snapshot 原子投影；storage V1/legacy strict decoder、future fail-closed、validated rollback；non-context persisted apply deny-only。
3. **T1b — Evidence-grade persistence（已交付核心）**：recordId/sequence（flat V2）、跨进程 writer 锁、namespace/audit journal 恢复（abort 默认、`RECOVERY_REQUIRED` fail-closed、committed 需两文件 exact identity 证明）与 doctor/升级提示已落地并有 fault-injection / 双进程并发 / SIGKILL 测试；新文件创建的目录 fsync 限制如实披露。用作 T1/T2 promotion evidence 前仍需按 §10 独立评审。
4. **T1 — Context shadow**：完整接入 context 四参数 observation，但只 shadow；同版本 baseline、信号去敏、窗口/规则/审计和 restart E2E 全绿。
5. **T2 — Context apply opt-in**：用户按 namespace 显式启用；下一窗口 validation、inconclusive rollback、冻结和 UI/CLI 可见性全绿，独立安全评审通过。
6. **T3 — Additional namespaces**：Router、Retry、Tool-timeout 每个单独做 threat/effect/budget evidence；不能因 context 通过而批量解锁。
7. **T4 — Dashboard（可选）**：只读展示 T2/T3 的真实数值 evidence，不扩大调参能力；自然语言 Memory lesson 不在本节路线图内。

所有阶段都遵守 [§10 evidence-gated roadmap](./10-milestones.md)：class、fixture、mock 或 unit test 只能证明局部实现；必须有 supported entry、composition wiring、边界 E2E 和同 SHA evidence 才能提升状态。

### 15.12 与 §18 的隔离契约

- §15 不能写仓库 worktree、创建 branch/commit、运行测试命令、启动 Developer/Reviewer 或消费 Human approval。
- §18 可以把 §15 的**去敏 shadow 指标**作为人工查看的 proposal clue，但不能据此自动创建/批准 run；输入需重新按 §18 policy 固定和审计。
- §18 的 policy、approval、sandbox、permission、auth、CI/release 永远不是 §15 tunable。
- 两系统的 store、state、receipt、CLI 和事件 schema 必须分开；`volund evolution` 不得成为 `volund selfdev` 的别名。

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-22 | §15 v2.3 | T1b：flat V2 `recordId`/per-namespace `sequence`（锁内分配、严格递增）；跨进程 lock（stale 接管）；`.evolution-txn.json` journal `PREPARED→NAMESPACE_DURABLE→BOTH_DURABLE`，abort 默认、`RECOVERY_REQUIRED` fail-closed、committed 需双文件 exact identity 证明；doctor 提示；新文件创建的目录 fsync 限制披露。 |
| 2026-08-21 | §15 v2.2 | T1a：冻结 context bounds/cross constraint；untrusted snapshot 整体投影；EvolutionRecordV1 + strict/bounded decoder、legacy provenance、future fail-closed、validated rollback；non-context persisted apply deny-only；明确 evidence-grade/双文件原子性留 T1b。 |
| 2026-08-21 | §15 v2.1 | T0 default-off：engine 与 production 仅接受显式 boolean true；缺失/false 使用默认，坏配置/错类型停止 Runner，全部失败分支均不读 tuning；保留 show/rollback 维护面，observe/validate 仍未接线。 |
| 2026-08-19 | §15 v2 | 重命名为 Adaptive Runtime Tuning；与 §18 代码/制品变更分离；按生产调用链标注 partial/unwired；明确当前规则驱动而非模型驱动；目标默认 off、先 shadow、apply 需 evidence gate；安全参数永久排除。 |
| 2026-08-01 | §15 v1（r10） | 首版 runtime parameter tuning 设计；历史内容中的闭环/默认/接线表述已由 v2 当前事实表取代。 |
