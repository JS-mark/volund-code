# Volund CLI — 设计文档 (Design Spec)

> **状态**：🚧 In Progress（规范包含 shipped、partial 与 proposed 内容；章节状态必须逐项读取，不能把设计存在等同于产品已实现）
> **日期**：2026-08-21
> **作者**：Mark + Claude
> **相关**：[AGENT.md](../../../../AGENT.md) · [CLAUDE.md](../../../../CLAUDE.md)

---

## 摘要 (TL;DR)

Volund CLI 是 claude-code 的开源平行实现：**多模型后端的终端 AI 编码 CLI**。

| 维度          | 决策                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定位          | claude-code 开源平行实现，不绑定厂商                                                                                                               |
| Provider 策略 | 多 Provider 插件化 + 中间路由层（fallback / role-based）                                                                                           |
| MVP 范围      | L4：对话 + 工具 + 权限 + MCP + 子 Agent + Skill/Plugin/Hooks（分阶段落地）                                                                         |
| 终端 UI       | Ink（React for CLI）                                                                                                                               |
| 安全          | 权限弹窗 + **Rust 沙箱**（fork codex 底座；**L1: mac/linux 4 target 硬约束；L2 补齐 Windows Tier1 + Linux musl 至 8 target**；三产物均独立二进制） |
| Rust 面积     | 沙箱 + 搜索/AST（ripgrep + tree-sitter）+ FS diff/tokenize，其他 TS；**三产物均独立二进制（r9）**                                                  |
| 存储          | 纯文件（JSONL 会话 + toml 配置）                                                                                                                   |
| 分发          | npm JavaScript 包 + 固定版本 GitHub Release native assets + SHA-256 校验                                                                           |
| 构建          | rolldown + Vite 8 + Cargo                                                                                                                          |
| 遥测          | **默认本地文件**，OTel 网络上报显式 opt-in                                                                                                         |
| 开发范式      | **AI 完全开发 + 人定方向**（spec 即可执行契约；详见 [§12.6b](./12-open-governance.md)）                                                            |
| 自适应调优    | [§15](./15-self-evolution.md)：规则驱动运行时参数 tuning；当前仅 partial/unwired，目标默认 off、先 shadow、apply 需 evidence gate                              |
| 扩展/安全内核 | [§19](./19-plugin-kernel.md) + [§19a](./19a-capability-contract.md)：目标原则 **Everything extensible is a plugin; the security kernel is not**；single-registry raw-byte contract、signed output endorsement→CEB→CAB→独立 adoption/enable、InvocationDecisionProof → Grant → exact Broker token、Rust-owned OS brokers；当前约 30% / partial，P0-00 deny-only fence 已在 `33e5ce5` 独立 review 0C/0I 后保持关闭，其余 P0/ABI/CAT 未交付，Rust-enforced 仍是 target claim |
| 受控自我开发  | [§18](./18-self-development.md) + §19/§19a：K3 CEB → signed human approval → PREPARED lock + independent AnchorStore ANCHORED → idempotent FINALIZED，再加 fenced Catalog/Git effects → `RELEASED_COMPLETED` history的只读 `STAGED_DISABLED` 投影；**proposed / not shipped** |
| 自有 Harness    | [§20](./20-harness.md)：harness 作为一等架构层——四层边界、H-1…H-14 核心不变量（验收宪法，符合性另证）、一个核心 × N driver 契约（D1–D6）、HarnessSpec 行为版本快照、self-hosting 路线（H0–H2、H3a/H3b、H4）；**proposed / not shipped**，机制细则权威仍在 §2–§19 各章 |
| 本地 Web 控制台 | [§22](./22-web-console.md)：`volund web` 本地 loopback 控制台，复用同一 app-runtime/Runner/EventBus/PermissionManager，覆盖会话、权限、扩展管理和可观测性；远程、手机、微信/企微、团队协作进入长期独立路线；**proposed / not shipped** |

---

## 目录（AI / 编辑器可跟进的相对路径）

原始整文档与后续提案已按顶级章节 §1–§22 拆分到本目录下的独立模块文件。链接使用相对路径 Markdown，
在 GitHub、VS Code、绝大多数 IDE 与 AI 阅读器中均可点击/跳转。

| §   | 章节                                                   | 文件                                                               | 行数 |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------ | ---- |
| 1   | 仓库布局 (v3, review 修正版)                           | [`01-repo-layout.md`](./01-repo-layout.md)                         | 249  |
| 2   | 核心数据模型与 Agent Loop                              | [`02-agent-loop.md`](./02-agent-loop.md)                           | 354  |
| 3   | Provider 抽象层 & Router 策略                          | [`03-provider-router.md`](./03-provider-router.md)                 | 426  |
| 4   | 工具体系与权限                                         | [`04-tools-permissions.md`](./04-tools-permissions.md)             | 264  |
| 5   | Rust 侧车（沙箱 + 搜索 + FS）                          | [`05-rust-sidecar.md`](./05-rust-sidecar.md)                       | 264  |
| 6a  | Skill / Plugin / MCP / Hooks — 核心插件架构（6.1–6.4） | [`06a-plugins-core.md`](./06a-plugins-core.md)                     | 372  |
| 6b  | PromptComposer + 插件生命周期（6.5–6.11）              | [`06b-prompt-composer.md`](./06b-prompt-composer.md)               | 500  |
| 6c  | Memory 系统（长期记忆，6.12）                          | [`06c-memory-system.md`](./06c-memory-system.md)                   | 292  |
| 6d  | 测试基建 testkit（6.13，r13 新增）                     | [`06d-testkit.md`](./06d-testkit.md)                               | ~80  |
| 7   | 终端 UI (Ink)                                          | [`07-terminal-ui.md`](./07-terminal-ui.md)                         | 182  |
| 8   | 会话与配置存储                                         | [`08-session-config.md`](./08-session-config.md)                   | 291  |
| 8b  | 上下文管理（ContextPolicy，r9 新增）                   | [`08b-context-policy.md`](./08b-context-policy.md)                 | ~280 |
| 9   | 构建 / CI / 分发                                       | [`09-build-ci-dist.md`](./09-build-ci-dist.md)                     | 163  |
| 10  | 证据门路线图 R0 → R6                                   | [`10-milestones.md`](./10-milestones.md)                           | 动态 |
| 11  | CLI 命令树设计                                         | [`11-cli-commands.md`](./11-cli-commands.md)                       | 290  |
| 12  | 开源治理                                               | [`12-open-governance.md`](./12-open-governance.md)                 | 141  |
| 13  | 文档站 IA + 官网首页                                   | [`13-docs-site.md`](./13-docs-site.md)                             | 220  |
| 14  | 首次运行 UX / Onboarding                               | [`14-onboarding.md`](./14-onboarding.md)                           | 210  |
| 15  | 自适应运行时调优（experimental / partial）              | [`15-self-evolution.md`](./15-self-evolution.md)                   | 动态 |
| 16  | 能力追踪与验收基线                                     | [`16-capability-traceability.md`](./16-capability-traceability.md) | 动态 |
| 17  | Code Review 功能（r13 新增）                           | [`17-code-review.md`](./17-code-review.md)                         | ~130 |
| 18  | 受控自我开发 / 变更流水线（proposed / not shipped）     | [`18-self-development.md`](./18-self-development.md)               | 动态 |
| 19  | Plugin Kernel / Capability ABI v2（phase re-plan）      | [`19-plugin-kernel.md`](./19-plugin-kernel.md)                     | 动态 |
| 20  | 自有 Harness（Self-owned Agent Harness）                | [`20-harness.md`](./20-harness.md)                                 | 动态 |
| 21  | 动态反思（Dynamic Reflection，K1 builtin 插件，proposed） | [`21-dynamic-reflection.md`](./21-dynamic-reflection.md)           | 新增 |
| 22  | Volund Web Console（本地 Web 控制台，proposed）         | [`22-web-console.md`](./22-web-console.md)                         | 动态 |

### 附属专题文档

| 主题                                          | 文件                                                   | 说明                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 跨平台沙箱兼容性白皮书 (SANDBOX-COMPAT r1)    | [`SANDBOX-COMPAT-r1.md`](./SANDBOX-COMPAT-r1.md)       | L1: 4 target × 3 crate = 12 平台包；L2: 8 target × 3 = 24 平台包；5 ADR；per-target Tier / escape 矩阵                                                                                                                                            |
| 插件 Provider 扩展白皮书 (PLUGIN-PROVIDER r1) | [`PLUGIN-PROVIDER-r1.md`](./PLUGIN-PROVIDER-r1.md)     | ProviderRegistry 端点；3 决策（sandbox stream/main 注入凭据/显式进 Router）；凭据分层；边界 B1-B8 + 风险 S1-S5                                                                                                                                    |
| 插件 /status 面板扩展白皮书 (PLUGIN-STATUS-UI r1) | [`PLUGIN-STATUS-UI-r1.md`](./PLUGIN-STATUS-UI-r1.md) | 数据契约式面板扩展：registerSection/registerTab；rows/heatmap/table 三种声明式体例；sanitize 规则；落地门禁 = 插件激活解禁 |
| /plugins 管理面板 + 市场链路白皮书 (PLUGIN-MANAGER r1) | [`PLUGIN-MANAGER-r1.md`](./PLUGIN-MANAGER-r1.md) | 三页签浏览（builtin/dev/market）+ CommandTabsView 描述符 + `volund.plugins.*` 桥 + `[plugins] market` digest 安装链（`~/.volund/plugins/`，激活期完整性重验）；签名/吊销留给 Catalog v2 |
| /skills 与 /mcp 命令白皮书 (SKILLS-MCP-UI r1) | [`SKILLS-MCP-UI-r1.md`](./SKILLS-MCP-UI-r1.md) | 两个 REPL 管理面板 + 协议对齐业界通用结构：skill 对齐 agentskills.io（标准字段/多作用域/.agents/skills 互操作）、MCP 对齐 mcpServers 键 + .mcp.json 导入 + `mcp__server__tool` 命名 + OAuth 2.1；任务卡 SM-01~08（L2/L3） |
| /subagents 运行管理面板 (SUBAGENTS-UI r1) | [`SUBAGENTS-UI-r1.md`](./SUBAGENTS-UI-r1.md) | dispatcher 运行注册表（生命周期/用量/取消）+ `/subagents` 面板（列表/取消/详情/秒级轮询）；运行是 REPL 进程本地，不设跨进程 CLI（§S5 偏差声明） |
| 设计评审报告 (REVIEW r6)                      | [`REVIEW-r6.md`](./REVIEW-r6.md)                       | P0/P1/P2/P3 + 功能缺口清单（14 节全评审）                                                                                                                                                                                                         |
| 设计评审报告 (REVIEW r7)                      | [`REVIEW-r7.md`](./REVIEW-r7.md)                       | 复审：核对 r6 落地状态 + 新发现 P0×1/P1×4/P2×5/P3×4（含配置注入、平台包 18v24 矛盾、Memory 模型面工具缺失）                                                                                                                                       |
| 设计评审报告 (REVIEW r8)                      | [`REVIEW-r8.md`](./REVIEW-r8.md)                       | 全量一致性复审：补审治理文件 + 系统扫描（§4.13 幻影引用 / 6-8 target 语义 / 事件数 / priority 槽 / 里程碑对齐），P0/P1 全清，P2 文档矛盾全清                                                                                                      |
| 设计评审报告 (REVIEW r9)                      | [`REVIEW-r9.md`](./REVIEW-r9.md)                       | 「设计本身好不好」独立复审：范围/复杂度/context 智能层/stream 计费/@UX/JSONL/codex 依赖等系统性短板 + 10 项处置落地（Rust 全二进制化 + L1 砍范围 + ContextPolicy 补齐 + @ 统一 picker + JSONL 分段 + stream 复用 + hook kv + provider-plugin L3） |
| 设计评审报告 (REVIEW r10)                     | [`REVIEW-r10.md`](./REVIEW-r10.md)                     | 三原则落地：AI-native 开发范式（§12.6b）+ 自我进化贯穿框架（§15 双层记忆 + 各节点自调优 + 安全边界冻结）+ Context 透明可控（CLI + TUI 面板）                                                                                                      |
| 文档正确性审计 (REVIEW r11)                   | [`REVIEW-r11.md`](./REVIEW-r11.md)                     | spec/ADR/治理文档 vs 实现的一致性审计：治理文档 24 条过时/幻影、06c 被 ADR 取代未回收、PLUGIN-PROVIDER-r1 六项核心未落地、CLI 命令面漂移；配套整改方案见 [plans/2026-08-15-design-remediation.md](../../../superpowers/plans/2026-08-15-design-remediation.md) |
| 文档正确性审计 (REVIEW r12)                   | [`REVIEW-r12.md`](./REVIEW-r12.md)                     | r11 补全（剩余十卷 02/03/04/05/08/08b/09/12/13/14，审计闭环）：契约层真实、组装层系统性未接线；最高危 Bash 5s 强杀 / Write-Edit 不过沙箱 / hooks 全谱未派发 / config 信任门产品未接线；修正设计 REM-26~50 延续整改方案编号可直接合入 |
| 功能设计完整评审 (REVIEW r13)                 | [`REVIEW-r13.md`](./REVIEW-r13.md)                     | **纯功能设计视角**（不涉实现一致性）：六维度评审——功能完备性 gap（code review 缺失/后台 Bash/自定义 agent）/ 可实现性（glob 方言/Edit 契约/聚合规则等 AI 实现必需契约）/ 旅程 / 性能预算 / 测试基建 / 供应链；D1 收编 20 条"实现被迫自定"的契约空白；附录 A 为 §16 Code Review 完整设计草案；修正任务清单 25 项按 spec 文件分组 |
| L1 发版前可勾选清单 (r10.1 新增)              | [`RELEASE-CHECKLIST-L1.md`](./RELEASE-CHECKLIST-L1.md) | L1 MVP 发版闸门单一视图：把散落 §3-§14 各章的 L1 强制点 + DoD + §9.4 CI matrix（4 native + 4 escape）+ §10 完成闸门 8 项汇成可勾选清单；符合 §12.6b「spec 即 AI 可执行契约」                                                                      |
| 附录 B · 错误码登记表 (r13 新增)               | [`APPENDIX-B-error-codes.md`](./APPENDIX-B-error-codes.md) | `error.raised` code 集中 registry（来源/触发/UI 期望/可否重试）+ shared const + ESLint 禁裸字符串 + CI 校验（I3）                                                                                                                              |
| 附录 C · config 全量 schema (r13 新增)         | [`APPENDIX-C-config-schema.md`](./APPENDIX-C-config-schema.md) | config.toml 全 key 表（含 projectOverride 标注）+ 未知 key 策略 + 全量示例；zod schema 与文档的唯一真相源（I4）                                                                                                                               |
| 附录 D · 事件 payload 字段表 (r13 新增)        | [`APPENDIX-D-event-payloads.md`](./APPENDIX-D-event-payloads.md) | 19 种事件 per-event payload 契约 + per-event zod schema + CI 强制（I8）                                                                                                                                                                       |
| 附录 E · 契约空白登记表 (r13 新增)             | [`APPENDIX-E-contract-gap-registry.md`](./APPENDIX-E-contract-gap-registry.md) | r11/r12 审计暴露的 20 条"实现被迫自定"契约空白的收编登记（D1）                                                                                                                                                                                |
| Self-Development 原实施计划                     | [`2026-08-19-self-development-implementation.md`](../../plans/2026-08-19-self-development-implementation.md) | SD0–SD5 原依赖顺序与详细 identity/evidence/approval 契约；phase 顺序与候选范围已由 2026-08-20 re-plan 收窄                                                                                               |
| Plugin Kernel + Self-Development 实施计划        | [`2026-08-20-plugin-kernel-implementation.md`](../../plans/2026-08-20-plugin-kernel-implementation.md) | **当前执行顺序权威**：ARCH → P0-00 legacy fence（已于 `33e5ce5` 完成并保持关闭）→ ABI-00 contract → P0-01…03 → Catalog core → brand migration/exact-SHA reverify → ABI runtime → migration → K3 fenced dual-effect promotion → prerelease；brand discovery 可只读并行                                      |
| Volund Web Console 实施计划                       | [`2026-08-28-volund-web-console.md`](../../plans/2026-08-28-volund-web-console.md) | P0–P7：spec/API/security → `app-runtime` 抽取 → loopback gateway → session/chat/permission → 管理面板 → 可观测性/review → hardening/beta；本地定时任务 F1 与远程/团队/微信企微 F2 均为后续独立门 |
| Capability Contract V1（ABI-00）                 | [`19a-capability-contract.md`](./19a-capability-contract.md) | §19 byte-level规范附录：single machine registry、Canonical JSON/domain/strict signature、closed DAG、signed output endorsement/full K3 identity、injective SafeDisplay、protected authority refs、anchored SelfDev transitions、content/authority-generation Catalog state、bounded verification sources与TS/Rust corpus；**review draft / not shipped，P0-00仍关闭** |

> 各文件内保留原章节编号（如 `## §1`、`### 1.1`），可与 git 历史里的旧单文件版本一一对应。

---

## 阅读顺序建议

- **想快速了解全貌** → 从 §1 → §2 → §10 走一遍。
- **想理解运行时/内核** → §20 (Harness 总览与边界) → §2 (Agent Loop) → §3 (Provider) → §4 (Tools) → §5 (Rust) → §19 (Plugin Kernel) → §19a (Capability Contract)。
- **想理解扩展生态** → §19（边界/ABI）→ §19a（byte contract）→ §6a → §6b → §6c → §11 (CLI)。
- **想理解落地/交付** → §7 → §8 → §9 → §14。
- **想参与共建** → §12（治理）→ §10（里程碑）。
- **想区分“参数调优”和“程序改自己”** → §15（Adaptive Runtime Tuning）→ §19（K3 边界）→ §18（Self-Development；当前未交付）。
- **想理解本地 Web 产品与实现顺序** → §22（功能/安全/架构）→ [Web 实施计划](../../plans/2026-08-28-volund-web-console.md)；远程连接只读 §22.6 W-18 / 计划 F2，不进入首版本地范围。

---

## 章节间交叉引用速查

- **§1 布局** 是 §3/§4/§5/§6 的目录归宿参照
- **§2 Agent Loop** 定义了 §3 Router、§4 Tool、§6 Hook 的调用契约
- **§3 Router** ↔ **[PLUGIN-PROVIDER-r1](./PLUGIN-PROVIDER-r1.md)** ↔ **§6 插件**：插件 provider 经 ProviderRegistry 进 Router 候选池（受控扩展，不破坏 Router 强制）
- **§4 Tool** 与 **§5 Rust 沙箱** 通过 §5.6 `native-bridge` 对接
- **§5 Rust 沙箱** ↔ **[SANDBOX-COMPAT-r1](./SANDBOX-COMPAT-r1.md)** ↔ **§9.4 CI matrix** ↔ **§10 L1 闸门** ↔ **§14.3b Tier 披露** 形成沙箱一等公民闭环
- **§19 Plugin Kernel** 是 §4/§5/§6 的新总约束：所有可扩展能力走 closed-role Capability ABI；**§19a** 以 single registry冻结 raw-byte canonical/domain/signature、signed output endorsement→CEB、Manifest embedded subdocs、protected authority refs/decision proof、三流 Catalog heads与 limits；K0 分为 TS control plane 与 Rust enforcement plane，handler 使用 InvocationGrant、具体 effect 使用 exact BrokerCallToken，workspace-fs/HTTP/process 由 Rust-owned broker 直接执行；sandbox/permission/verifier/catalog/mandatory security gates/human gate 都不是插件
- **§20 自有 Harness** 是 §2/§3/§4/§5/§6/§8 的综合视图与边界冻结：harness 四层边界、H-1…H-14 核心不变量、driver 契约 D1–D6、HarnessSpec 行为快照；机制细则冲突时原章节赢（§20.11）
- **§22 Volund Web** 是 §2/§4/§7/§8/§11/§16 的浏览器 adapter：必须先从 `apps/cli` 抽出 UI-neutral `app-runtime`，复用 CoreEvent、SessionStore 与 PermissionManager；本地 loopback 是当前范围，远程/团队/消息平台独立进入 R6+。
- **§20.7 HarnessSpec** 的 digest 复用 §19a canonical/signature 约定，为 §16 能力验收、§18 eval 证据与 CI golden 回归提供统一归因锚点；`session.started` 新 payload 字段须先登记附录 D（r13-I8 流程）
- **§6 Plugins** 描述当前 v1 surfaces，并与 **§4 Tool 注册**、**§8 Config**、**§11 CLI** 交叉；迁移到 Manifest/ABI v2 时以 §19 为权威
- **§10 里程碑** 与各章节末尾的"里程碑"小节形成 vertical/horizontal 交叉视图
- **§15 Adaptive Runtime Tuning** 只调白名单数值参数；**§18 Self-Development** 才涉及候选制品，且 SD4 前不得宣称可开启
- **§18** 复用§4/§5安全原语、§17 review与§9/§10 evidence gate；v1由**§19/§19a**收窄为K3 capability。Primary store的PREPARED锁与independent monotonic AnchorStore共同实现crash-safe logical commit；ANCHORED后幂等FINALIZED exact receipt/run/reservation/pointer，`STAGED_DISABLED`仅由`RELEASED_COMPLETED` history+matching CompletionReceipt投影。AMBIGUOUS old run终态失败，signed reconciliation只允许fresh human lineage

---

## 修改约定

- 结构性调整（新增/删除章节、跨节改动）→ 更新本 README 目录与"章节间交叉引用"。
- 章节内演进（在已有章节内改进）→ 直接改对应模块文件即可，无需回改本 README。
- 每次实质性变更请在文件头保留 `> **状态**` / `> **日期**` 类的元数据行（章节文件继承主文档头信息即可，也可在文件顶部按需追加子状态）。

---

## 归档

- 单文件旧版本已归档为 `../2026-07-31-volund-code-design.archived.md`（如仍存在，仅供历史查阅，请勿再编辑）。
