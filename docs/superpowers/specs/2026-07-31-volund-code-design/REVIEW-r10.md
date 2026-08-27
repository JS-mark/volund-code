> ↩ [返回索引 (README)](./README.md) · ← [REVIEW-r9](./REVIEW-r9.md)

---

# REVIEW r10 · 三原则落地：AI-native 范式 + 自我进化 + Context 透明可控

- 审查范围：响应用户三条顶层原则，对 spec 做「范式级」修订（非补漏，是定位重塑）
- 审查日期：2026-08-01
- 审查方法：与用户确认 3 个决策点（双层进化载体 / AI 协作约定深度 / context 交互程度），落地 7 项处置
- 结论摘要：r6-r9 把「设计本身好不好」审透了；r10 补上「**项目以什么方式存在**」——AI 完全开发、自我进化贯穿、context 对人透明。三条原则共同把 volund 从「一个 CLI 工具」升级为「一个会进化的、AI 原生的编码伙伴」。

---

## 第一部分 · 三条原则与决策

| 用户原则 | 决策 | 落地 |
|---|---|---|
| **AI 完全开发、人定方向** | §12 加 AI-native 协作约定节 + 全局语境校准（单人→AI 执行+人决策；时间估算改 AI 迭代口径） | 任务 3+4 |
| **核心智能层透明可控** | §8b 增透明可控能力（CLI `volund context` + TUI `/context` 面板 + 强制保留/手动压缩/看 diff） | 任务 2 |
| **不断自我进化（贯穿性）** | 新建 §15 自我进化框架（双层：Memory scope=tuning + 独立 tuning 配置）；各能力节点埋接入点 | 任务 1+6 |

---

## 第二部分 · 7 项处置落地表

| # | 处置 | 落地位置 | 状态 |
|---|---|---|---|
| 1 | **新建 §15 自我进化框架** | 新建 [`15-self-evolution.md`](./15-self-evolution.md)（~230 行：双层记忆 Memory scope=tuning + tuning/*.jsonl + 通用进化循环 OHAV + 接入点矩阵 Context L2/Router+Retry+Tool L3/Sandbox 观察 only + 安全护栏 + 人机协作 + 边界 + 配置 + 里程碑） | ✅ |
| 2 | **§8b Context 透明可控** | [`08b-context-policy.md`](./08b-context-policy.md) 新增 §8b.13（CLI `volund context show/diff/keep/unkeep/compact/policy` + TUI `/context` 面板 + hook 联动）+ §8b.14（首个进化接入点）+ §8b.9 边界 2 条 + §8b.10 事件 2 条 | ✅ |
| 3 | **§12 AI-native 协作约定** | [`12-open-governance.md`](./12-open-governance.md) 新增 §12.6b（范式声明 + spec AI 可执行性标准 + AI 提交 review 标准 + 人在环检查点 5 类 + superpowers 协作工具流程）+ §12.7 校准（BDFL 人决策+AI 执行） | ✅ |
| 4 | **全局语境校准** | [`10-milestones.md`](./10-milestones.md) 时间估算改「AI 迭代轮数」口径（L1 8-12 轮 / 总计 33-45 轮）+ L2/L3 补进化系统条目；[`README.md`](./README.md) TL;DR 补「开发范式」+「自我进化」两行；§12.5b RFC 清单补「进化护栏参数变更需 RFC」 | ✅ |
| 5 | **§11 CLI 增 context + evolution** | [`11-cli-commands.md`](./11-cli-commands.md) §11.2 顶层命令 18→20 + §11.3.12 context 子节 + §11.3.13 evolution 子节 + §11.4 slash 补 `/context` + §11.7 里程碑（L2 context/evolution、L3 evolution enable/disable） | ✅ |
| 6 | **§15 跨节接入点** | [`03-provider-router.md`](./03-provider-router.md) §3.7 Router + §3.9a Retry 接入点；[`04-tools-permissions.md`](./04-tools-permissions.md) §4.3 Tool timeout 接入；[`05-rust-sidecar.md`](./05-rust-sidecar.md) §5.5 Sandbox 仅观察不接入；[`06c-memory-system.md`](./06c-memory-system.md) §6.12.1 scope=tuning | ✅ |
| 7 | **README + changelog + REVIEW-r10 汇总** | [`README.md`](./README.md) 目录表加 §15 + 附属文档表加 REVIEW-r10 + TL;DR；§14 changelog 追加 r10 行；新建本文件 | ✅ |

---

## 第三部分 · 设计哲学说明

### 为什么这三条原则是「范式级」而非「补漏级」

r6-r9 的所有修订都是在既定范式内优化（契约更自洽、安全更扎实、范围更合理、文档更一致）。r10 的三条原则改变了 volund 的**存在方式**：

1. **AI-native 范式**（原则 1）：承认「spec 是 AI 的可执行契约，人是检查点」。这让 spec 的严谨性从「便于人理解」升级为「决定 AI 产出正确性」——每个强制点都是 AI 出错的兜底。时间估算从「人写多久」改为「AI 迭代多少轮 + 人审批多快」，更诚实地反映开发模式。

2. **自我进化贯穿**（原则 3）：这是最根本的变化。r6-r9 的 volund 是「静态调优」——参数靠人配、靠 spec 固化。r10 后 volund 是「动态进化」——ContextPolicy/Router/Retry/Tool 参数根据本用户使用信号渐进调整。进化系统有严格护栏（安全边界冻结、步长受限、恶化回滚、可关闭、可审计），确保「进化」不变成「失控」。

3. **Context 透明可控**（原则 2）：让最不透明的智能层（context 压缩）变成用户能看、能改、能强制保留的能力。配合自我进化，context 管理从「黑箱魔法」变成「透明的、会自我改进的、人可控的机制」。

### 三条原则如何相互支撑

- **AI-native**（原则 1）需要 **自我进化**（原则 3）：AI 开发的项目，运行时也应由 AI 主导调优（人定护栏，AI 在护栏内进化）
- **自我进化**（原则 3）需要 **Context 透明**（原则 2）：进化调整 context 参数后，用户必须能看到效果（否则进化是黑箱）
- **Context 透明**（原则 2）服务于 **AI-native**（原则 1）：透明的 context 让人能有效审批 AI 的 context 相关决策

---

## 第四部分 · 进化系统的边界（明确不做什么）

为避免「自我进化」被误解为「AI 自我意识/失控」，明确边界：

- ❌ **不进化安全边界**：sandbox / permission / untrusted / dangerous-* / hook priority 永不参与自调优（§15.5 冻结）
- ❌ **不全自动无监督**：累计大调整（偏离默认 >30%）需人确认（§15.6）
- ❌ **不跨用户聚合**：进化只读本机本用户信号（隐私红线）
- ❌ **不预测性调优**：只反应式（基于已发生信号），不预测
- ❌ **不可关闭后仍生效**：`[evolution] enabled=false` → 所有参数立即回内置默认

进化系统的设计哲学：**用得越久越贴合本用户，但人始终是最终决策者，且随时可关停/回滚**。

---

## 第五部分 · 数字对比（r6-r10 五轮）

| 轮次 | 焦点 | 净增 spec 行 | 新建文件 |
|---|---|---|---|
| r6 | 契约安全（P0-P3 + 功能缺项） | ~0（修订为主） | REVIEW-r6 |
| r7 | 运行时安全复审 | ~0 | REVIEW-r7 |
| r8 | 文档一致性 | ~0 | REVIEW-r8 |
| r9 | 设计本身好不好（范围/智能层/UX） | ~600 | 08b-context-policy.md + REVIEW-r9 + 15-self-evolution.md(r10 前身无) |
| r10 | AI-native 范式 + 自我进化 + Context 透明 | ~400 | 15-self-evolution.md + REVIEW-r10 |

---

## 最终结论

r10 落地三条顶层原则，volund 的定位从「claude-code 的开源平行实现」深化为「**AI-native、自我进化、context 透明的开源编码伙伴**」。

7 项处置全部落地。进化系统有严格护栏确保不失控。AI-native 范式在 §12.6b 明确 spec 即契约、人是检查点。

**建议下一轮（若有 r11）聚焦**：L1 实现启动后的「进化系统首个接入点验证」——ContextPolicy 自调优在真实长会话中是否能稳定改善（信号采集是否噪声大、步长是否合适、恶化回滚是否及时）。以及 superpowers skill 工作流（§12.6b）在 volund 自举开发中的实际效能。

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-01 | r10 v1 | 三原则落地：(1) AI-native 范式——§12.6b AI-native 开发协作约定 + 全局语境校准（时间估算改 AI 迭代口径）；(2) 自我进化贯穿——新建 §15（双层记忆 Memory scope=tuning + tuning/*.jsonl + OHAV 进化循环 + 接入点矩阵 + 安全护栏 + 人机协作）；(3) Context 透明可控——§8b.13 CLI volund context + TUI /context 面板 + §8b.14 首个进化接入点。7 项处置全落地。进化边界明确（安全冻结/不全自动/不跨用户/不预测/可关停）。 |
