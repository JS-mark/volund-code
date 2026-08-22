> ↩ [返回索引 (README)](./README.md) · ← [上一章: §19 Plugin Kernel](./19-plugin-kernel.md)

---

## §20 自有 Harness（Self-owned Agent Harness）

> **状态：PROPOSED / NOT SHIPPED。**
>
> 本章把 harness 确立为 Apollo Code 的一等架构层：定义术语与四层边界、核心不变量、组件所有权、driver 契约、HarnessSpec 行为快照与自托管路线。本章**不创造新运行时机制**：loop、prompt、context、tool、permission、hook、storage、kernel 的细则权威仍在 §2–§19 各章。实现状态的唯一权威是 §10 的同-SHA evidence gate；[§16 能力矩阵](./16-capability-traceability.md) 是冻结于 `origin/main@74723303`（2026-08-10）的可追溯基线，复审时按新证据刷新，不得把该冻结基线当作当前实现的实时证明。出现细则冲突时按 §20.11 仲裁。

### 20.1 术语：harness 是什么

**Harness** = 模型之外、决定「模型看到什么、能做什么、何时停止」的全部确定性运行时：会话与事件模型、agent loop、prompt 组装、上下文策略、工具面与权限、hook 管线、subagent 编排、存储与恢复，以及把这些能力接到不同入口的 driver。

行业语境里「模型 + harness = agent 产品」：同一模型在不同 harness 下的能力表现可以差出档位；上下文工程、工具面设计、中断恢复的质量与模型本身同样决定产品上限。Apollo Code 的定位（claude-code 开源平行实现）本质上就是**自有 harness 项目**——但此前各章只分散定义了 harness 的零件，没有一处回答 harness 作为整体的四个问题：

1. **边界**：什么属于 harness、什么不属于；
2. **不变量**：换模型、换 driver、加插件时，什么绝不允许变；
3. **版本**：两次运行的 harness 是否相同，如何证明；
4. **归属**：哪些面永远由 harness 核心拥有，不可外包给插件或模型。

本章冻结这四问的答案。四层边界：

| 层 | 内容 | 细则权威 | 自有性要求 |
|---|---|---|---|
| Model | 权重与推理，vendor 拥有 | §3 | **永不自有**；可替换是设计前提 |
| **Harness（本章）** | loop / prompt / context / tools / permission / hooks / events / storage / drivers | §2/§4/§5/§6b/§8/§8b + 本章综合 | **必须自有**（Apache-2.0 clean-room，§20.2） |
| Product surface | CLI / TUI / 文档站 / onboarding | §7/§11/§13/§14 | 自有 |
| Extension | plugin / skill / MCP / hook | §6a/§19/§19a | 第三方可进入，但只能经 closed-role ABI（§19），永不获得 harness 核心所有权 |

### 20.2 「自有」的三层含义

| 层 | 含义 | 强制语义 |
|---|---|---|
| 法律/供应链自有 | Apache-2.0 clean-room 实现 | 不 vendor、不反编译、不动态加载任何厂商 harness 运行时；只在公开协议与 API 层互通。harness 核心包（§20.5 标 ★ 者）的第三方运行时依赖列入依赖审计重点面（§9） |
| 架构自有 | harness 是显式设计、有独立版本的一层 | harness 行为可快照、可比对、可归因（HarnessSpec，§20.7）；不是某个 provider adapter 或 TUI 的副产物 |
| 演进自有 | harness 的变更权只在本项目流程内 | 行为变更走 §12 治理 + §10 证据门；不跟随任何上游 harness 的版本节奏；§15 tuning 与 §18 self-dev 只能在 §20.4 不变量之内演化 |

永久反模式（任何 PR 引入即拒）：

- 把 harness 核心逻辑外包给「模型自己想出来的流程」——模型输出永远只是 untrusted proposal（§15.5/§18 同口径）；
- 把 harness 行为定义在 provider 私有特性上（§20.8）；
- 以「兼容某产品」为名把对方 harness 的私有实现细节抄成本项目契约——平行实现学的是公开语义，不是私有实现。

### 20.3 现状缺口（为什么单设一章）

| 缺口 | 后果 | 本章对策 |
|---|---|---|
| 无整体边界定义 | 「这是不是 harness 该管的」逐案争吵；driver / 插件越界无判据 | §20.1 边界 + §20.5 所有权矩阵 |
| 不变量散落各章 | 重构或新增 driver 时，无人验收「harness 还是不是原来的 harness」 | §20.4 不变量清单作为验收宪法 |
| 无行为版本 | 两周后同一输入行为不同，无法归因模型漂移还是 harness 漂移 | §20.7 HarnessSpec digest |
| driver 各自生长 | TUI / headless / subagent 行为分裂；headless 权限语义靠实现自定 | §20.6 driver 契约 + conformance suite |
| dev harness 借用外部 CLI | §12.6b 的 AI-native 范式跑在别人的 harness 上，自托管无可表述的目标与门禁 | §20.10 self-hosting 阶段门 |

### 20.4 Harness 核心不变量（宪法）

以下不变量对**所有 driver、所有 provider、所有插件配置**成立；违反其一 = 架构 breach（与 AGENT.md §1.1 一等公民约束同级）。各条目的细则权威为引用章节，本节只做汇总冻结，不替代原文：

| # | 不变量 | 细则权威 |
|---|---|---|
| H-1 | SessionState 不可变，且只能经 Runner 公开 API 变更；UI / driver 不得直写 | §2.2 |
| H-2 | core 只发不订；事件 UUIDv7；所有 subscriber 经 seen-set / 幂等键去重 | §2.3 |
| H-3 | 每事件 payload 有注册 schema，实现不得自创形状 | §2.3（r13-I8）+ 附录 D |
| H-4 | turn 内 tool loop 有上限（B2）；interrupt 经 turnAbort 统一广播到 provider stream / tool.invoke / sandbox 子进程（B3） | §2.4 |
| H-5 | turn 内 provider sticky（B4）；fallback 只发生在锁定前 | §2.4 + §3.9a |
| H-6 | max_tokens 截断只提示、不自动续写（B7） | §2.4 |
| H-7 | 权限决策只能由 permission 子系统产生；subagent 内授权档位收窄为 allow-once / allow-session / deny（W8） | §2.5 + §2.7 |
| H-8 | builtin 安全 hook fail-closed；拦截型 hook 5s 超时按域分治 | §2.6（r13-I10） |
| H-9 | untrusted 内容（项目级 agent 定义、memory、工具输出等）经包裹协议进 prompt | §6.5.0a + §2.7.1 |
| H-10 | 副作用工具默认走 sandbox；sandbox 二进制缺失时拒绝执行，除非显式 `--dangerous-no-sandbox` | §2.8 + §5 |
| H-11 | context 压缩只能由 ContextPolicy 决定；模型与 driver 不得绕过 | §8b |
| H-12 | storage 失败降级 in-memory、session 存活；不得静默丢历史 | §2.8 + §8 |
| H-13 | 安全平面（permission / sandbox / verifier / catalog / mandatory security gates / human gate）不可插件化 | §19.4 |
| H-14 | subagent 受嵌套（默认 3）/ 并发（默认 4）/ 三维 budget（cost·token·time）上限；事件冒泡保留原 event.id | §2.7 |

**符合性口径（2026-08-22 审计）**：上表冻结的是验收宪法——任何 driver / provider / 插件配置违反其一即架构 breach——而不是「当前实现已全部满足」的声明。逐条当前符合性以 §16 基线加 §10 同-SHA 证据为准并持续刷新。该审计确认 H-2、H-8、H-12、H-13 在 tip SHA 上尚无完整符合性证据（局部实现/测试存在——例如事件 UUIDv7 与 seen-set 去重、builtin hook 5s 超时 fail-closed——但 H-12 的 storage 故障 in-memory 降级在当前代码中未找到实现，其余各条的逐项覆盖也未经同-SHA 验收）。在逐项同-SHA 证据补齐前，本章只声明这些不变量为契约，不声明其已被满足。

新增、修改或删除不变量 = 本章结构性变更，须走 README 修改约定（更新目录与交叉引用）+ §10 证据门。

### 20.5 组件所有权矩阵

★ 标记的是「在 harness 中的角色」一列中的核心职责（responsibility-level），不是把整个包列为内核所有；包内其他可扩展 surface 仍按 §19/§19a 的 closed-role ABI 迁移与约束，§20.2 的供应链自有性强约束适用于承担 ★ 职责的代码路径。依赖方向与注入端口以 [§1.2–§1.5](./01-repo-layout.md) 为权威，本表只声明角色归属。「主包」列中「当前」是 2026-08-22 的真实实现位置，「目标」是 §1/§19 迁移后的目标 owner；二者不得混写，不存在的目标包不得当作现有事实引用。

| 组件 | 主包 | 细则权威 | 在 harness 中的角色 |
|---|---|---|---|
| Runner / SessionState / EventBus | `packages/core` ★ | §2 | **harness 心脏**：loop、turn、abort、事件 |
| PromptComposer / PromptFragment | `packages/core` ★ | §6b | 模型输入的唯一组装口（B1） |
| ContextPolicy 契约与策略 | `provider-kit` 契约 + `packages/context` ★ | §8b | 模型上下文窗口的唯一裁剪刀（H-11） |
| Tool / ToolRegistry 契约 | `packages/tool-kit` ★ | §4 | 模型手部的唯一登记处 |
| Permission 决策 + promptHandler 端口 | `packages/permission` ★ | §4 | 安全平面（H-7/H-13），不可插件化 |
| 内置工具 | `packages/tools` | §4.3 | harness 自带手部实现，经同一 Registry 进出 |
| Router 策略 | `packages/router` ★ | §3 | provider 选择；策略可换，pick/sticky 契约不可换（H-5） |
| Provider adapters | `packages/provider-*` | §3 | **不属于 harness**；harness 只依赖 provider-kit 契约 |
| Hooks 注册表 / 装载与内置 hook | HookRegistry 契约目标归 `packages/core` ★（§2.6，当前代码中尚不存在）；管线当前在 `packages/plugin-runtime`（domain-hooks）；目标独立包 `packages/hooks` | §2.6 + §6.11 | 管线编排；builtin 域 fail-closed（H-8） |
| Storage（JSONL/toml） | `packages/storage` ★ | §8 | 持久化订阅者；故障降级语义 H-12 |
| native-bridge / sandbox | `packages/native-bridge` ★ + `crates/apollo-sandbox` | §5 + §19.7 | 安全执行平面，Rust-owned（H-10/H-13） |
| subagent runtime | `packages/subagent` | §2.7 | harness 内生的第二 Runner 生产者（RunnerFactory 注入） |
| skill / plugin / MCP 装载器 | `skills-runtime` / `plugin-runtime` / `mcp-client` | §6a + §19 | 扩展入口；closed-role ABI 约束，无核心所有权 |
| memory-runtime | 当前 `packages/storage`（memory-runtime.ts 等）；目标 `packages/memory-runtime` | §6c | untrusted 内容生产者，进 prompt 必经 H-9 |
| testkit | `packages/testkit`（dev-only） | §6d | conformance 与 fixture 基建（§20.6 消费方） |
| 组装层 | `apps/cli` ★ | §1.5 | 唯一「什么都知道」的 composition root；driver 的宿主 |

### 20.6 Driver 模型：一个核心 × N 个驱动面

**Driver** = 启动 Runner、喂入用户输入、订阅事件流、提供权限 promptHandler 的适配层。driver 之间共享且仅共享同一个 core；这是「一个 harness」而非「四个相似程序」的结构性保证。

| Driver | 入口 | 输入源 | 权限交互 | 输出 | 状态 |
|---|---|---|---|---|---|
| interactive TUI | `apollo`（Ink，TTY） | 键盘 | TUI 弹窗（permission promptHandler） | 渲染事件流 | `verified-local`（§16 基线） |
| line-mode | `apollo chat "<prompt>" --no-tui` | argv（prompt） | 行式确认 | stdout 文本 | `verified-local`（§16 基线） |
| headless NDJSON | `apollo chat "<prompt>" --json` | argv（prompt；不支持 stdin 管道输入） | 无交互 → 默认 deny（fail-closed），预授权须走显式 profile | 版本化 NDJSON（无 ANSI/TUI 帧） | `verified-local`（§16 基线）；driver 契约待 H2 补齐 |
| subagent | Task tool（§2.7） | 父 Runner | W8 收窄档位 | 末条 assistant text 作 tool_result | `verified-local`（§16 基线） |
| SDK embed（提案） | `createHarness()` API | 宿主程序调用 | 宿主回调 | 事件迭代器 | **v2 提案 / not shipped** |

**Driver 契约（每条可测）**：

- **D1 同一 core**：driver 只能组合 core 公开 API 与 §1.5 注入端口；在 driver 内复制 loop / prompt / tool / permission 逻辑 = 架构违规。
- **D2 事件消费**：driver 只消费 §2.3 + 附录 D 注册的事件与 payload；禁止解析渲染文本反推状态。
- **D3 权限端口唯一**：`permission.setPromptHandler` 是 driver 唯一的权限界面（§1.5 端口 1）。headless 无 handler 时必须默认 deny；任何预授权 profile 走 §4 审计面并在 HarnessSpec 中可见（§20.7）。
- **D4 abort 映射**：driver 的取消语义（Ctrl+C / SIGTERM / API cancel / 父 Runner budget 命中）必须映射到 `runner.interrupt()`（H-4 的 B3 链）；禁止以杀进程冒充中断。
- **D5 终态与退出码**：headless 必须冻结 turn 终态 → 进程退出码的映射表（供 CI 与脚本消费）；映射表属 §11 契约面，H2 阶段冻结，草案：`0` = 全部 turn 正常完成；`1` = 运行时错误；`2` = 权限拒绝导致目标未达成；`3` = 预算/上限终止（B2 / subagent budget）。
- **D6 不改 Spec**：driver 不得修改 HarnessSpec 任何字段；运行参数只能经 config 白名单进入 core（§8 / 附录 C）。

**Conformance suite（H2，§6d 扩展）**：同一组 `MockProvider` 脚本 + `sessionFixture` 跑过全部 driver，断言**事件序列等价**（渲染层差异除外）：同一输入在 TUI / line / headless / subagent 下产生同构的 `turn.*` / `tool.*` / `message.appended` 序列。新 driver 上新前必须过 suite；suite 归 §6d testkit，CI 强制。

### 20.7 HarnessSpec：行为版本快照

**问题**：同一输入两周后行为不同，是模型漂移还是 harness 漂移？没有行为版本，该问题不可回答，§16 验收与 §18 eval 都缺归因锚点。

**定义**：`HarnessSpec` = Runner 启动时冻结、随会话落盘的行为快照，内容为各 digest 的集合（不含任何用户数据与凭据）：

| 字段 | 内容 | 来源权威 |
|---|---|---|
| `promptFragments` | fragment id + priority + 内容的 domain-separated canonical digest（compose 前的输入清单；不使用裸 SHA-256，避免低熵内容的字典式关联确认） | §6b / §6.5 |
| `toolSchemas` | 工具名 + inputSchema 的 domain-separated canonical digest | §4 + §19a |
| `loopParams` | maxToolLoopsPerTurn、subagent 深度/并发/budget 默认、top_level_budget | §2.4/§2.7 |
| `contextPolicy` | 策略种类 + 四参数（compaction_threshold / target_ratio / keep_recent / summary_keep_recent）+ 策略版本 | §8b + §15.6 |
| `routerPolicy` | 策略种类 + config digest（凭据永不进 digest 输入） | §3.8 |
| `hookRegistry` | 事件点 + handler id + 域 + priority 的 digest | §2.6/§6.11 |
| `sandbox` | profile / tier / kernel 版本 | §5 + §19.7 |
| `permissionProfile` | 预授权 profile 标识（D3），不含具体决策 | §4 |
| `harnessBuild` | 当前构建的 exact 标识（版本 + 可用时的构建 digest/渠道） | §9 + app-identity |
| `activeCapabilities` | 当前装配的 capability 清单与来源：硬编码组合期如实记录为 `hardwired-composition`；Catalog 落地后改为 exact binding 引用 + catalog epoch，不再允许无来源清单 | §19.8 + §20.5 |

**规范与计算**：digest 输入的 canonicalization 复用 §19a 的 Canonical JSON V1 编码约定（key 排序、值域、最短十进制整数），**single registry**，不得另起第二套字节规范。HarnessSpec 不是 §19a 的 closed artifact role、也不进入其 DAG；所有 HarnessSpec digest 使用本章自有 domain prefix（如 `harness-spec.v1`、`harness-spec-fragment.v1`），按 §19a.3.2 的 `ASCII(prefix)+NUL+uint64_be(length)+canonical bytes` 构造，禁止任何裸 SHA-256。digest 计算函数本身属于 harness 核心（§20.9：插件不能贡献 digest 算法）。

**落盘与可读面**：`HarnessSpec` 以 `harness.spec.json` 形式写入会话目录，并由 `session.started` 事件 payload 引用其 digest——该 payload 新增字段须先登记附录 D（r13-I8 流程）后才允许发出。`apollo doctor` 与 `apollo session inspect` 展示当前 spec digest。

**用途**：

1. **复现/归因**：同一 spec digest + 同一模型版本 → 残余行为差异只剩模型采样与外部世界状态；
2. **回归门禁**：CI golden 测试断言 spec digest 变化必须伴随 changeset 与 spec 改动说明；
3. **§18 证据锚**：self-dev 候选制品的 eval 报告必须记录 harness spec digest，否则「行为变好」无法与 harness 变更区分；
4. **§16 验收绑定**：能力行绑定 SHA 时同步绑定 spec digest。

**非目标**：spec 不含模型权重、provider 内部状态、用户数据；spec digest 是行为归因工具，不替代安全审计。

### 20.8 模型解耦与能力协商

provider-neutral 已由 §3 建立；本节冻结 harness 侧的配套纪律：

- **capability 唯一入口**：loop 内的行为分支只能依据 §3 的 provider capabilities（如 `parallelToolCalls`、thinking、vision、context window）；**禁止**在 `packages/core` 及 §20.5 标 ★ 包内按 provider 名 / 模型名分支。CI lint：`packages/core` 禁止 import 任何 `provider-*` 包或 provider 名常量。
- **降级阶梯**：capability 缺失走固定降级，不发明第三路径——无并行 tool call → 串行（§2.5 已有）；无独立 system 字段 → adapter 转 `messages[0]`（§2.4 B1 已有）；无 vision → 附件拒绝并 UI 提示，不静默丢弃。
- **sticky 是唯一让渡**：B4 的 turn 内 provider 锁定是 harness 对模型可替换性的唯一例外，且严格限于 turn 内（H-5）。
- **模型不得反向定义 harness**：模型输出里的「流程建议」（如要求改 loop 顺序、改权限语义）一律只是 untrusted proposal（§20.2 反模式）。

### 20.9 安全平面归属（与 §19 对齐）

§19.4 已冻结「sandbox / permission / verifier / catalog / mandatory security gates / human gate 都不是插件」。本章补充 harness 视角的归属表，与 §19 不冲突、不复制其细则：

| 面 | 所有者 | 可否插件化 | 依据 |
|---|---|---|---|
| permission 决策 / promptHandler 端口 | harness 核心（`packages/permission`） | 否 | §19.4 + H-7 |
| sandbox 执行平面（Rust broker） | harness 核心（`crates/*`） | 否 | §19.4/§19.7 + H-10 |
| verifier / catalog / adoption / enable receipt | harness 核心 | 否 | §19/§19a |
| human approval（§18 trust root） | harness 核心 | 否 | §18.2.1 |
| HarnessSpec digest 算法 | harness 核心 | 否 | 本节 §20.7 |
| 工具 / skill / MCP / provider / hook | 可扩展面 | 是，经 closed-role ABI | §19/§19a |
| §15 可调参数 | 白名单数值，永不触碰上四行 | 不适用 | §15.2/§15.8 |

### 20.10 自托管路线（self-hosting）

**诚实现状**：§12.6b 的 AI-native 范式（AI 完全开发 + 人定方向）当前运行在外部 harness 上（Claude Code / ZCode 类 CLI）。这是事实陈述而非缺陷；但「自有 harness」的完整含义包括**最终由 Apollo Code 自己的 harness 承载自己的开发**。自托管不是营销目标，是 §20.1 四问的最终验收：只有当 apollo 能用自身 harness 完成自身开发循环，边界、不变量、driver 契约才算被真实世界检验过。验收分两层：H3a 是 human-directed dogfood（人直接驾驶，不走 §18 pipeline）；H3b 是 §18 K3 controlled self-development dogfood，终点仅为本地 branch + Catalog `STAGED_DISABLED`（§20.12）。

**永久约束**：

- 自托管不降低任何安全平面要求：apollo-as-dev-harness 里的每次 run 同样受 H-1…H-14 与 §19 不变量约束；
- §18 的 self-dev run 必须跑在本 harness 的 fenced profile 内（§19 K3），不得因为「是自己开发自己」而获得额外 authority；H3b 不得自动 adoption、enable、push、merge、tag、publish 或 deploy；
- 自托管 evidence 按 §10 标准记录（supported entry + composition wiring + 边界 E2E + 同 SHA CI），不得以「能启动聊天」宣称自托管达成。

### 20.11 权威关系与冲突仲裁

本章是**综合视图 + 边界冻结**。仲裁规则：

1. 机制细则（loop 怎么跑、prompt 怎么拼、事件 payload 什么形状）冲突时：**原章节赢**（§2/§3/§4/§5/§6/§8/§19 等），本章服从；
2. 以下四件事本章是唯一权威：harness 术语与四层边界、H-1…H-14 不变量清单、driver 契约 D1–D6、HarnessSpec 的字段集与用途；
3. 要把某细则的权威迁入本章 = 结构性变更，按 README 修改约定执行（更新目录、交叉引用、受影响章节的状态行）。

### 20.12 落地阶段与证据门

对齐 §10 状态词汇与 shared exit gate；每阶段退出须满足 supported entry + composition wiring + 直接/边界测试 + 同 SHA CI + 独立评审。

| 阶段 | 内容 | 退出标准 | 状态 |
|---|---|---|---|
| **H0** | 本章：术语 / 边界 / 不变量 / 契约冻结 | 本章合入；README 目录与交叉引用更新；不改代码；不声明 H-1…H-14 的当前符合性 | **本阶段**（proposed） |
| **H1** | HarnessSpec：schema + digest + 会话落盘 + doctor 展示 | 附录 D 登记 `session.started` 新 payload 字段；digest 稳定性测试（同输入同 digest；任一 fragment 变化 → digest 变化 + changeset）；doctor 输出 E2E | missing |
| **H2** | driver conformance suite + headless 契约补齐 | §6d conformance suite 覆盖 TUI/line/headless/subagent 事件序列等价；D5 退出码映射冻结入 §11；headless 权限 fail-closed 边界测试 | missing |
| **H3a** | human-directed dogfood gate | 人直接使用 apollo 作为 dev harness 完成一张真实实现任务卡（worktree + 测试 + 人工 PR 全流程），证据按 §10 记录；不使用 §18 SelfDev pipeline，也不冒充自我开发 | missing |
| **H3b** | §18 K3 controlled self-development dogfood | 第一条 K3 run 走完整 §18/§19a 链（isolated development → deterministic verification → independent acceptance → human approval → anchored completion），止于本地 branch + Catalog `STAGED_DISABLED`；不得自动 adoption/enable/push/merge/publish/deploy | missing（依赖 SDP 全链） |
| **H4**（可选，v2） | SDK embed driver 公开 API 稳定化 | API 冻结 + conformance suite 通过 + 版本化承诺 | missing |

**登记义务（R0 对齐）**：§16 能力矩阵下次复审时须新增 harness 行（HarnessSpec / driver conformance / human-directed dogfood / K3 self-dev dogfood），状态从 `missing` 起，不得以本章合入为由标记任何 `verified-*`。

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-22 | §20 v1.1 | 审计修复：HarnessSpec 字段改 domain-separated canonical digest（禁裸 SHA-256）并补 `harnessBuild`/`activeCapabilities` 绑定；H-1…H-14 明确为验收宪法而非当前符合性声明，登记 H-2/H-8/H-12/H-13 证据缺口；driver 表修正为真实 CLI（`apollo chat "<prompt>" --json` / `--no-tui`，无 `-p`，无 stdin 管道 prompt）；ownership ★ 降为职责级标记，HookRegistry 契约目标归 core（当前代码中不存在），hooks/memory 拆当前路径与目标归属；§16 表述降级为冻结基线；self-hosting 验收拆分为 H3a（human-directed）与 H3b（§18 K3，止于 STAGED_DISABLED）；driver 表状态列对齐 §10/§16 词汇（`verified-local` 基线）。 |
| 2026-08-21 | §20 v1 | 首版：harness 确立为一等架构层；四层边界与「自有」三含义；H-1…H-14 核心不变量；组件所有权矩阵；driver 契约 D1–D6 与 conformance suite；HarnessSpec 行为快照；模型解耦纪律；§19 安全平面对齐；self-hosting 路线与 H0–H4 阶段门。全章 proposed / not shipped，不宣称任何新运行时能力。 |
