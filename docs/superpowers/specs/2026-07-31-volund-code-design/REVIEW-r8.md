> ↩ [返回索引 (README)](./README.md) · ← [REVIEW-r7](./REVIEW-r7.md)

---

# REVIEW r8 · 全量文档一致性复审（治理文件 + 系统扫描）

- 审查范围：在 r7（14 节 + SANDBOX-COMPAT + AGENT/CLAUDE）基础上，**补齐此前漏审的三大块**：
  1. 根目录 4 个治理文件（`LICENSE` / `SECURITY.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md`）与 §12 spec 的一致性
  2. 归档文件 `.archived.md` 完整性确认
  3. 跨文档系统一致性扫描（里程碑对齐 / 数字一致 / 跨节引用锚点有效性）+ r7 修复轮（r8-fix）的自洽性复查
- 审查日期：2026-08-01
- 审查方法：通读治理文件 + `grep` 系统扫描（target 数 / 事件数 / §X.Y 引用 / vm 残留 / priority 槽位）+ 里程碑逐项对齐
- 结论摘要：**本轮暴露了 r7 漏审的 6 类文档级问题**（治理文件与 spec 漂移、§4.13 幻影引用、6/8 target 语义混淆、事件数漏更新、§6.5 priority 表与 §6.12.8 不同步、§6.10 残留旧引用）。这些问题虽非运行时安全漏洞，但会让实现者按错版本写代码。全部已在同批修复。**至此 16 个文档文件 + 4 个治理文件已全量审过**。

---

## 第一部分 · 治理文件核对（此前漏审）

### LICENSE
- 标准 Apache-2.0 全文。与 §12.1（"主许可 Apache License 2.0"）一致。✅ 无需改。

### CODE_OF_CONDUCT.md
- Contributor Covenant v2.1 官方文本。与 §12.4 一致。email `conduct@volund-code.dev` 标注了 "placeholder — will be replaced before public release"，合理。✅ 无需改。

### SECURITY.md —— 发现 3 处与 spec 漂移（已修）

| 问题 | 修复 |
|---|---|
| scope 写 `Plugin sandbox breakout (vm.createContext escape, JSBridge abuse)` —— 用**作废的 node:vm 语义**（r2 已改 Rust sandbox 子进程） | 改为 `escape from the volund-sandbox --run-plugin subprocess isolation, JSBridge abuse, RPC whitelist bypass` |
| scope 写 Linux `landlock+seccomp` —— r3 后 Linux 默认是 **bundled bwrap**，landlock 降为 fallback | 改为 `bundled bwrap+seccomp (landlock fallback)` + 补 bwrap digest tampering 进 supply chain scope |
| hardening resources 引用旧单文件路径 `2026-07-31-volund-code-design.md`（已拆成目录） | 改为目录路径 + 注明拆分结构 |
| **已做但 r7 误判为缺**：第 28 行**已列** GitHub Security Advisory（r6 功能缺项 #14 实际已闭环） | r7 处置表订正：#14 实际已解决 |

> 补充发现：SECURITY.md 的"Supported versions"表（`Latest 0.x tag ✅`）比 §12.3 spec 的表**更准确**（spec 那张表 r7 才改对，而 SECURITY.md 一直是 0.x 现实语义）。说明治理文件某些方面比 spec 更早到位。

### CONTRIBUTING.md —— 发现 2 处与 spec 漂移（已修）

| 问题 | 修复 |
|---|---|
| 第 98 行 `CI matrix must pass on all 6 targets` —— 应是 8 native targets | 改 8 + 注明 6 平台组合 + 2 musl |
| 第 190 行 `Rust × 6 targets` —— 同上 | 改 `8 native targets + 8 sandbox-escape jobs` |
| 第 5 行引用旧单文件路径 | 改为 spec 目录路径 |

> CONTRIBUTING.md 整体质量高：branching model（L1-L2 trunk / L3+ next）、RFC 7 天冷静期、DCO、测试分层都与 spec §12.5 / §10 一致。

---

## 第二部分 · 系统一致性扫描发现（6 类问题）

### SCAN-1 · §4.13 幻影引用（最严重，已修）

- **问题**：spec 全文有 **7 处** 引用 `§4.13`（telemetry 隐私强约束），但 **spec §4 只到 §4.12**，§4.13 根本不存在。这些引用实际指的是 **AGENT.md §4.13**（治理文件里的"遥测隐私强约束"段），但写成了 `§4.13` 没指明是 AGENT.md，读者会去 spec §4 找，找不到。
- **位置**：`01-repo-layout.md` / `06c-memory-system.md` / `08-session-config.md`（4 处）
- **修复**：全部改为显式 `[AGENT.md §4.13](../../../AGENT.md#413-遥测隐私强约束)`，并在适用处补 spec `§8.7` 交叉引用。
- **严重度**：中——不会导致写错代码（语义能猜到），但新人 onboarding 时会困惑。

### SCAN-2 · 6 vs 8 target 语义混淆（已修）

- **问题**：文档同时出现"6 target"和"8 target"，读者无法判断哪个对。真相：**6 平台组合**（mac/linux/win × arm64/x64，产品覆盖口径）vs **8 Rust native target**（6 + 2 musl，CI/编译口径）vs **24 平台包**（8 × 3 crate，npm 分发口径）—— 三个不同维度，但文档没解释，措辞混用。
- **修复**：§5 开头加"口径说明"段，明确 6/8/24 三个数字的指代；README TL;DR 改为"6 平台组合 + Linux musl 分裂 = 8 Rust native target"。各处"6 target"在语境指平台组合的保留（加说明后读者能理解），指 Rust target 的已在上轮改为 8。
- **严重度**：中——实现者可能按错维度数 CI job。

### SCAN-3 · 事件数 16→17 漏更新（已修）

- **问题**：§8.2 W10 新增了 `session.resumed` 事件（replay 时替代 session.started），但 §2.3 事件表**没加这行**，§10/§13/§8.2 仍写"16 事件/16 种事件"。实际是 17。
- **修复**：§2.3 表补 `session.resumed` 行；§8.2/§10/§13 的"16 事件"改 17（§14 changelog 历史记录保留不改）。
- **严重度**：低——文档数字，但 telemetry schema 文档化时会出错。

### SCAN-4 · §6.5 priority 表与 §6.12.8 不同步（已修）

- **问题**：§6.12.8 引入了 3 个新 priority 槽位（`builtin:memory-guide` 950 / `memory:pinned` 700 / `plugin:<name>:memory` 60），但 §6.5 的"内置来源与默认优先级"表**只列了旧的 5 行**（1000/800/600/400/50），没同步 memory 的 3 行。读者看 §6.5 会以为只有 5 个槽位。
- **修复**：§6.5 表补全 8 行 + 注明 L1 无 memory 时后 3 槽为空。
- **严重度**：中——PromptComposer 实现者按 §6.5 表写会漏掉 memory 槽位。

### SCAN-5 · §6.10 残留旧引用 "§5.9-L2"（已修）

- **问题**：r7 修复轮改了 §6.10 开头那句"§5.9 的 L2 → §5.11 的 L2"，但 §6.10 里程碑表**正文第一项** "L1（依赖 §5.9-L2）" **漏改**（同一节第二处出现）。§5.9 是平台包矩阵，§5.11 才是里程碑。
- **修复**：改为"项目轨 §5.11 的 L2"。
- **严重度**：低——交叉引用错误，但能从上下文推断。

### SCAN-6 · node:vm 残留（合理，未改）

- **问题**：全文仍有多处 `node:vm`。
- **判定**：全部在"作废/禁止/对比表/changelog"语境（§6.4.3 决策对照表列 node:vm 作为被否决方案、§6.7"不再是 node:vm"、§14 changelog 记录历史）。这些是**有意保留**的决策溯源，不是遗漏。✅ 无需改。

---

## 第三部分 · 里程碑对齐核对（全部一致）

逐项核对各节里程碑表（§4.12 / §5.11 / §6.10 / §6.12.12 / §11.7 等）与 §10 总里程碑的 L 归属：

| 能力 | §10 总里程碑 | 各节里程碑 | 一致？ |
|---|---|---|---|
| Skill | L2 | §4.12 Skill.activate L2 / §11.7 skill* L3（CLI） | ✅ |
| Plugin | L3 | §6.10 plugin-L1=项目L3 / §11.7 plugin* L3 | ✅（§6.10 有映射表） |
| MCP | L3 | §11.7 mcp* L3 | ✅ |
| MultiEdit | L2 | §4.12 L2 | ✅ |
| Task/subagent | L3 | §4.12 L3 | ✅ |
| WebFetch/Search | L4 | §4.12 L4 | ✅ |
| Windows Tier | 1=L1/2=L2/3=L3 | §5.11 一致 | ✅ |
| memory | L2 起 | §6.12.12 L2 | ✅ |

**结论**：里程碑矩阵完全对齐，无错位。

---

## 第四部分 · r7 修复轮（r8-fix）自洽性复查

对 r7 报告里 r8-fix 落地的 40 处编辑做交叉引用复查：

| r8-fix 引入 | 被引用处是否自洽 | 状态 |
|---|---|---|
| §3.9a 流式中断处理 | §2.4 loop / §2.4 B4+B6 / §2.8 异常谱 / §3.2 chunk / §3.6 错误类 / §3.7.1 sticky 全部正确引用 | ✅ |
| `message.interrupted` chunk | §3.2 定义 + §3.9a 语义 + §2.4 处理，转成 `error.raised{stream_interrupted}`（已在 §2.3 事件谱）| ✅ |
| Memory 模型面工具（§6.12.2a） | §6.12.3 memory-guide 文案对齐 / §4.3 工具清单补 / §4.12 里程碑补 L2 | ✅ |
| untrusted 包裹（§6.5.0a） | §6.5.1 内置 prompt 配套 / Memory 工具返回引用 §6.5.0a | ✅ |
| 配置注入信任门（§8.3.1） | §8.8 边界 / §11.6 边界 / §11.3.1 flag / §14.4 说明 全部引用 | ✅ |

**结论**：r8-fix 的契约自洽，无引入新矛盾。

---

## 第五部分 · 数字对比（含 r7 + r8 两轮）

| 级别 | r7 初查净开放 | r8-fix 后 | r8 复审新增 | r8 复审修复后 |
|---|---|---|---|---|
| P0 | 6 | 0 | 0 | **0** |
| P1 | 14 | 0 | 0 | **0** |
| P2 | 19 | 14 | 6（SCAN-1~5 + §4.13） | **0**（全修；SCAN-6 合理保留） |
| P3 | 13 | 8 | 0 | **8**（延后打磨项） |

---

## 最终结论

**设计文档现已全量审过**：16 个 spec 文件 + SANDBOX-COMPAT + AGENT.md/CLAUDE.md + 4 个治理文件 + 归档文件。经过 r7（运行时安全契约）+ r8-fix（落地修复）+ r8（文档一致性）三轮，**P0/P1 全清，P2 文档级矛盾全清**，剩余仅 P3 可选打磨项。

### 本轮（r8）的价值
r7 只审了"设计的骨架"，漏了"文档作为可执行规范的自洽性"。r8 补上了：治理文件与 spec 的双向漂移、跨节引用的有效性、数字与里程碑的对齐。这类问题不致命，但在 L1 实现启动时会让贡献者按错版本写代码。建议把 r8 用到的扫描脚本（grep target 数 / §X.Y 引用 / 事件数 / priority 槽位）固化成 CI 的 docs-lint job，防止后续改动再引入漂移。

### 仍存在的已知限制（非 bug，已记 known-limitation）
- 功能缺项 #2（stream resume-from-offset，v2）/ #12（跨系统循环检测总规则，各单点已限流）/ #13（非沙箱 fuzzing spec，L2 补）/ #14（GHSA 渠道已在 SECURITY.md，docs 站可补链接）
- P2 延后项（Cron / MCP inspect timeout / @include magic-byte 等，进 L2-L3）
- P3 打磨项（sticky violation 文案细节 / seen-set LRU 上限调优等）

这些都不阻塞 L1 发版。

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-01 | r8 v1 | 全量文档一致性复审：补审治理文件（SECURITY.md 3 处 vm/landlock/路径漂移 + CONTRIBUTING.md 2 处 6→8 target/路径漂移，全修）+ 归档完整性确认 + 系统扫描发现 6 类问题（§4.13 幻影引用 ×7、6/8 target 语义混淆、事件数 16→17、§6.5 priority 表缺 memory 槽、§6.10 残留 §5.9-L2、node:vm 合理残留）。里程碑矩阵核对全对齐。r8-fix 自洽性复查通过。P0/P1 全清，P2 文档矛盾全清。 |
| 2026-08-01 | r8 v2 | **插件 Provider 扩展设计**（响应用户需求"引入受控 ProviderRegistry 端点让插件注册 ProviderClient"）。新建 [`PLUGIN-PROVIDER-r1.md`](./PLUGIN-PROVIDER-r1.md) 白皮书（§P1-P13）：三大决策（D1 sandbox 子进程 + 专用 stream 通道 / D2 main 注入凭据 header-template 默认 + signing 降级 / D3 显式配置才进 Router 不能 default）+ ProviderRegistry 端点 + stream-over-RPC 协议 + 凭据注入分层（S1 防线）+ VolundBridge.provider/auth 命名空间 + manifest kind:provider + 边界 B1-B8 + 风险 S1-S5 + §3.10/§6.4.1/§6.7/§6.9/AGENT.md §4.10.1a/§4.12/CLAUDE.md C4 差量落地。逆转两条原绝对约束为"受控开放"：§6.4.1 "不暴露 volund.provider" → "直调禁止，register 受控开放"；§3.10 "Runner 禁 import provider-*" → "经 ProviderRegistry 拿引用"。归 v2 候选里程碑。 |
